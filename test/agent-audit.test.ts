import { describe, expect, it } from "vitest"
import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { AdmittedAgent } from "../src/agent-project.ts"
import { auditReloadedAgents } from "../src/agent-audit.ts"
import type { ModeSeed } from "../src/replay.ts"

/**
 * F17 Step 6 (ADR agent G8, G9, G11; C5): after the reload settles, the listing is compared
 * with what we replayed — field by field, plus a `seed ⊕ ours` permission prefix. A mismatch
 * is reported once and the ID is held out of the next snapshot.
 */

const ID = "nested.one.token-translator"
const SEED: readonly Permission.Rule[] = Agent.Info.default(ID as Agent.ID).permissions
const PARENT: Permission.Rule = { action: "bash", resource: "*", effect: "deny" }

interface ListedRow {
  id: string
  name: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  system?: string
  description?: string
  model?: { id: string; providerID: string; variant?: string }
  steps?: number
  permissions: Permission.Rule[]
  request: { settings: Record<string, unknown>; headers: Record<string, string>; body: Record<string, unknown> }
}

function admitted(overrides: Partial<AdmittedAgent> = {}): AdmittedAgent {
  return {
    id: ID,
    nativeName: "translator",
    name: "A/translator",
    mode: "subagent",
    hidden: true,
    system: "own prompt",
    description: "a description",
    model: { providerID: "anthropic", id: "claude" },
    steps: 3,
    permissions: [{ action: "read", resource: "a/**", effect: "deny" }],
    request: { headers: { "x-a": "1" }, body: { temperature: 0.2 } },
    ...overrides,
  }
}

function published(agent: AdmittedAgent, overrides: Partial<ListedRow> = {}): ListedRow {
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.mode ?? "primary",
    hidden: agent.hidden ?? false,
    ...(agent.system === undefined ? {} : { system: agent.system }),
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(agent.model === undefined
      ? {}
      : {
          model: {
            id: agent.model.id,
            providerID: agent.model.providerID,
            ...(agent.model.variant === undefined ? {} : { variant: agent.model.variant }),
          },
        }),
    ...(agent.steps === undefined ? {} : { steps: agent.steps }),
    permissions: [...SEED.map((rule) => ({ ...rule })), ...agent.permissions.map((rule) => ({ ...rule }))],
    request: {
      settings: {},
      headers: { ...agent.request.headers },
      body: { ...agent.request.body },
    },
    ...overrides,
  }
}

const listingOf = (...rows: ListedRow[]) => async () => ({ data: rows })

const audit = (
  agents: readonly AdmittedAgent[],
  shadowed: readonly string[],
  rows: ListedRow[],
  seed: ModeSeed = new Map(),
) => auditReloadedAgents({ agents, shadowed: new Set(shadowed), seed, list: listingOf(...rows) })

describe("a matching entry", () => {
  it("reports nothing when every field and the permission prefix match", async () => {
    const agent = admitted()

    const result = await audit([agent], [], [published(agent)])

    expect(result).toEqual({ shadowed: [], diagnostics: [] })
  })

  it("tolerates the parent's rules after ours", async () => {
    const agent = admitted()

    const result = await audit([agent], [], [published(agent, { permissions: [...published(agent).permissions, PARENT] })])

    expect(result).toEqual({ shadowed: [], diagnostics: [] })
  })

  it("ignores request settings, which are the host's", async () => {
    const agent = admitted()
    const row = published(agent)
    row.request.settings = { timeout: 5 }

    expect(await audit([agent], [], [row])).toEqual({ shadowed: [], diagnostics: [] })
  })
})

describe("one mismatched field", () => {
  const cases: ReadonlyArray<readonly [string, (row: ListedRow) => void]> = [
    ["mode", (row) => void (row.mode = "all")],
    ["hidden", (row) => void (row.hidden = false)],
    ["system", (row) => void (row.system = "someone else's prompt")],
    ["description", (row) => void (row.description = "edited")],
    ["model", (row) => void (row.model = { id: "gpt", providerID: "openai" })],
    ["steps", (row) => void (row.steps = 5)],
    ["request.headers", (row) => void (row.request.headers = { "x-a": "2" })],
    ["request.body", (row) => void (row.request.body = { temperature: 0.9 })],
  ]

  it.each(cases)("reports %s once and holds the ID out", async (_field, mutate) => {
    const agent = admitted()
    const row = published(agent)
    mutate(row)

    const result = await audit([agent], [], [row])

    expect(result).toEqual({ shadowed: [ID], diagnostics: [`agent-shadow-audit: ${ID}`] })
  })

  it("compares the effective mode and hidden when the source authored neither", async () => {
    const agent = admitted({ mode: undefined, hidden: undefined })

    const result = await audit([agent], [], [published(agent, { mode: "primary", hidden: false })])

    expect(result).toEqual({ shadowed: [], diagnostics: [] })
  })

  it("reports an entry that did not survive the reload", async () => {
    const result = await audit([admitted()], [], [])

    expect(result).toEqual({ shadowed: [ID], diagnostics: [`agent-shadow-audit: ${ID}`] })
  })
})

describe("the permission prefix", () => {
  it.each([
    ["our rule removed", (rules: Permission.Rule[]) => rules.slice(0, SEED.length)],
    [
      "our rules reordered",
      (rules: Permission.Rule[]) => [...rules.slice(0, SEED.length), ...rules.slice(SEED.length).reverse()],
    ],
    [
      "our rule replaced",
      (rules: Permission.Rule[]) => [...rules.slice(0, SEED.length), { action: "read", resource: "b/**", effect: "allow" as const }],
    ],
    [
      "a rule inserted between the seed and ours",
      (rules: Permission.Rule[]) => [...rules.slice(0, SEED.length), PARENT, ...rules.slice(SEED.length)],
    ],
  ])("reports %s", async (_case, mutate) => {
    const agent = admitted({
      permissions: [
        { action: "read", resource: "a/**", effect: "deny" },
        { action: "edit", resource: "b/**", effect: "allow" },
      ],
    })
    const row = published(agent, { permissions: mutate(published(agent).permissions) })

    const result = await audit([agent], [], [row])

    expect(result.diagnostics).toEqual([`agent-shadow-audit: ${ID}`])
  })
})

describe("dedupe and scope", () => {
  it("does not re-report an ID already held out", async () => {
    const result = await audit([admitted()], [ID], [])

    expect(result).toEqual({ shadowed: [], diagnostics: [] })
  })

  it("ignores rows for other IDs", async () => {
    const agent = admitted()
    const other = published(agent, { id: "nested.two.other", request: { settings: {}, headers: { "x-z": "9" }, body: {} } })

    expect(await audit([agent], [], [published(agent), other])).toEqual({ shadowed: [], diagnostics: [] })
  })

  it("reports every mismatched ID in one pass", async () => {
    const first = admitted()
    const second = admitted({ id: "nested.two.other" })

    const result = await audit([first, second], [], [])

    expect(result.shadowed).toEqual([first.id, second.id])
    expect(result.diagnostics).toEqual([`agent-shadow-audit: ${first.id}`, `agent-shadow-audit: ${second.id}`])
  })
})

describe("the inherited pair", () => {
  const seed: ModeSeed = new Map([["translator", { mode: "subagent", hidden: true }]])

  it("matches a row that published the same-named entry's pair", async () => {
    const agent = admitted({ mode: undefined, hidden: undefined })

    const result = await audit([agent], [], [published(agent, { mode: "subagent", hidden: true })], seed)

    expect(result).toEqual({ shadowed: [], diagnostics: [] })
  })

  it("reports the entry once when the inherited pair did not survive", async () => {
    const agent = admitted({ mode: undefined, hidden: undefined })

    // Without the seed the expected pair is the default, so the fix would report itself.
    const result = await audit([agent], [], [published(agent)], seed)

    expect(result).toEqual({ shadowed: [ID], diagnostics: [`agent-shadow-audit: ${ID}`] })
  })
})
