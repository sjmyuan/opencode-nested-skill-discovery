import { describe, expect, it } from "vitest"
import type { Permission } from "@opencode/schema/permission"
import type { AdmittedAgent } from "../src/agent-project.ts"
import type { AgentEditor } from "../src/plugin.ts"
import { applyAgents, type ModeSeed } from "../src/replay.ts"

/**
 * F17 Step 4 (ADR agent G1, G8): a frozen payload becomes map rows without mutating one ID
 * the editor already holds. The editor below mirrors the host contract — `update` inserts on
 * miss seeded by `Agent.Info.default` (`packages/schema/src/agent.ts:38-52`), and `default`
 * plus `remove` throw so any call is a failure rather than an assertion.
 */

interface Row {
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

const SEED_RULES: Permission.Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

function seedRow(id: string, patch: Partial<Row> = {}): Row {
  return {
    id,
    name: id,
    mode: "primary",
    hidden: false,
    permissions: SEED_RULES.map((rule) => ({ ...rule })),
    request: { settings: {}, headers: {}, body: {} },
    ...patch,
  }
}

function recordingEditor(initial: readonly Row[] = [], insert: Partial<Row> = {}) {
  const rows = new Map(initial.map((row) => [row.id, row]))
  const calls: string[] = []
  const editor = {
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id),
    default: () => {
      throw new Error("default must never be called")
    },
    remove: () => {
      throw new Error("remove must never be called")
    },
    update: (id: string, update: (row: Row) => void) => {
      calls.push(id)
      if (rows.get(id) === undefined) rows.set(id, seedRow(id, insert))
      update(rows.get(id) as Row)
    },
  }
  return { editor: editor as unknown as AgentEditor, rows, calls }
}

function admitted(overrides: Partial<AdmittedAgent> = {}): AdmittedAgent {
  return {
    id: "one/translator",
    nativeName: "translator",
    name: "A/translator",
    permissions: [],
    request: { headers: {}, body: {} },
    ...overrides,
  }
}

describe("insert on miss", () => {
  it("updates every absent ID in ID order and writes the authored fields", () => {
    const { editor, rows, calls } = recordingEditor()
    const payload = [
      admitted({ id: "b/second", name: "A/second" }),
      admitted({
        id: "a/first",
        name: "A/first",
        system: "own prompt",
        description: "a description",
        model: { providerID: "anthropic", id: "claude", variant: "fast" },
        steps: 3,
        mode: "all",
        hidden: true,
      }),
    ]

    const diagnostics = applyAgents(editor, payload, new Map())

    expect(diagnostics).toEqual([])
    expect(calls).toEqual(["a/first", "b/second"])
    expect(rows.get("a/first")).toEqual({
      id: "a/first",
      name: "A/first",
      system: "own prompt",
      description: "a description",
      model: { id: "claude", providerID: "anthropic", variant: "fast" },
      steps: 3,
      mode: "all",
      hidden: true,
      permissions: SEED_RULES,
      request: { settings: {}, headers: {}, body: {} },
    })
  })

  it("leaves the registry default in place for an absent mode and hidden", () => {
    const { editor, rows } = recordingEditor()

    applyAgents(editor, [admitted()], new Map())

    expect(rows.get("one/translator")?.mode).toBe("primary")
    expect(rows.get("one/translator")?.hidden).toBe(false)
  })
})

describe("inheritance (G4)", () => {
  const seed: ModeSeed = new Map([["translator", { mode: "subagent", hidden: true }]])

  it("writes the same-named entry's pair when the source authors neither field", () => {
    const { editor, rows } = recordingEditor()

    applyAgents(editor, [admitted()], seed)

    expect(rows.get("one/translator")?.mode).toBe("subagent")
    expect(rows.get("one/translator")?.hidden).toBe(true)
  })
})

describe("no overwrite", () => {
  it("skips an ID the editor already returns and leaves it byte-identical", () => {
    const existing = seedRow("one/translator", { name: "native", mode: "subagent" })
    const before = JSON.stringify(existing)
    const { editor, calls } = recordingEditor([existing])

    const diagnostics = applyAgents(editor, [admitted({ name: "A/translator", mode: "all", hidden: true })], new Map())

    expect(diagnostics).toEqual([])
    expect(calls).toEqual([])
    expect(JSON.stringify(existing)).toBe(before)
  })
})

describe("authority", () => {
  it("appends our rules after the four seed rules", () => {
    const { editor, rows } = recordingEditor()

    applyAgents(editor, [admitted({ permissions: [{ action: "read", resource: "a/**", effect: "deny" }] })], new Map())

    expect(rows.get("one/translator")?.permissions).toEqual([
      ...SEED_RULES,
      { action: "read", resource: "a/**", effect: "deny" },
    ])
  })

  it("merges headers and body key by key and never touches settings", () => {
    const { editor, rows } = recordingEditor([], {
      request: { settings: { timeout: 5 }, headers: { "x-seed": "s" }, body: { top_p: 0.9 } },
    })

    applyAgents(
      editor,
      [admitted({ id: "one/translator", request: { headers: { "x-a": "1" }, body: { temperature: 0.2 } } })],
      new Map(),
    )

    expect(rows.get("one/translator")?.request).toEqual({
      settings: { timeout: 5 },
      headers: { "x-seed": "s", "x-a": "1" },
      body: { top_p: 0.9, temperature: 0.2 },
    })
  })
})

describe("robustness", () => {
  it("applies a duplicated ID once", () => {
    const { editor, calls } = recordingEditor()

    const diagnostics = applyAgents(editor, [admitted(), admitted()], new Map())

    expect(diagnostics).toEqual([])
    expect(calls).toEqual(["one/translator"])
  })

  it("reports one failing entry and still applies its siblings", () => {
    const { editor, rows, calls } = recordingEditor()
    const failing = {
      ...editor,
      update: (id: string, update: (row: Row) => void) => {
        if (id === "b/second") throw new Error("boom")
        editor.update(id, update)
      },
    } as unknown as AgentEditor

    const diagnostics = applyAgents(
      failing,
      [admitted({ id: "a/first" }), admitted({ id: "b/second" })],
      new Map(),
    )

    expect(diagnostics).toEqual(["agent-replay: b/second: boom"])
    expect(calls).toEqual(["a/first"])
    expect(rows.get("a/first")?.name).toBe("A/translator")
  })

  it("does nothing for an undefined payload", () => {
    const { editor, calls } = recordingEditor()

    expect(applyAgents(editor, undefined, new Map())).toEqual([])
    expect(calls).toEqual([])
  })
})
