import { describe, expect, it } from "vitest"
import type { Permission } from "@opencode/schema/permission"
import type { AdmittedAgent } from "../src/agent-project.ts"
import type { AgentEditor } from "../src/plugin.ts"
import { applyAgents } from "../src/replay.ts"

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
    id: "nested.one.token-translator",
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
      admitted({ id: "nested.b.token", name: "A/second" }),
      admitted({
        id: "nested.a.token",
        name: "A/first",
        system: "own prompt",
        description: "a description",
        model: { providerID: "anthropic", id: "claude", variant: "fast" },
        steps: 3,
        mode: "all",
        hidden: true,
      }),
    ]

    const diagnostics = applyAgents(editor, payload)

    expect(diagnostics).toEqual([])
    expect(calls).toEqual(["nested.a.token", "nested.b.token"])
    expect(rows.get("nested.a.token")).toEqual({
      id: "nested.a.token",
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

    applyAgents(editor, [admitted()])

    expect(rows.get("nested.one.token-translator")?.mode).toBe("primary")
    expect(rows.get("nested.one.token-translator")?.hidden).toBe(false)
  })
})

describe("no overwrite", () => {
  it("skips an ID the editor already returns and leaves it byte-identical", () => {
    const existing = seedRow("nested.one.token-translator", { name: "native", mode: "subagent" })
    const before = JSON.stringify(existing)
    const { editor, calls } = recordingEditor([existing])

    const diagnostics = applyAgents(editor, [admitted({ name: "A/translator", mode: "all", hidden: true })])

    expect(diagnostics).toEqual([])
    expect(calls).toEqual([])
    expect(JSON.stringify(existing)).toBe(before)
  })
})

describe("authority", () => {
  it("appends our rules after the four seed rules", () => {
    const { editor, rows } = recordingEditor()

    applyAgents(editor, [admitted({ permissions: [{ action: "read", resource: "a/**", effect: "deny" }] })])

    expect(rows.get("nested.one.token-translator")?.permissions).toEqual([
      ...SEED_RULES,
      { action: "read", resource: "a/**", effect: "deny" },
    ])
  })

  it("merges headers and body key by key and never touches settings", () => {
    const { editor, rows } = recordingEditor([], {
      request: { settings: { timeout: 5 }, headers: { "x-seed": "s" }, body: { top_p: 0.9 } },
    })

    applyAgents(editor, [
      admitted({ id: "nested.one.token-translator", request: { headers: { "x-a": "1" }, body: { temperature: 0.2 } } }),
    ])

    expect(rows.get("nested.one.token-translator")?.request).toEqual({
      settings: { timeout: 5 },
      headers: { "x-seed": "s", "x-a": "1" },
      body: { top_p: 0.9, temperature: 0.2 },
    })
  })
})

describe("robustness", () => {
  it("applies a duplicated ID once", () => {
    const { editor, calls } = recordingEditor()

    const diagnostics = applyAgents(editor, [admitted(), admitted()])

    expect(diagnostics).toEqual([])
    expect(calls).toEqual(["nested.one.token-translator"])
  })

  it("reports one failing entry and still applies its siblings", () => {
    const { editor, rows, calls } = recordingEditor()
    const failing = {
      ...editor,
      update: (id: string, update: (row: Row) => void) => {
        if (id === "nested.b.token") throw new Error("boom")
        editor.update(id, update)
      },
    } as unknown as AgentEditor

    const diagnostics = applyAgents(failing, [
      admitted({ id: "nested.a.token" }),
      admitted({ id: "nested.b.token" }),
    ])

    expect(diagnostics).toEqual(["agent-replay: nested.b.token: boom"])
    expect(calls).toEqual(["nested.a.token"])
    expect(rows.get("nested.a.token")?.name).toBe("A/translator")
  })

  it("does nothing for an undefined payload", () => {
    const { editor, calls } = recordingEditor()

    expect(applyAgents(editor, undefined)).toEqual([])
    expect(calls).toEqual([])
  })
})
