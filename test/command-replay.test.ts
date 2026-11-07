import { describe, expect, it } from "vitest"
import { applyCommands, findCommand, type CommandTarget } from "../src/command-replay.ts"
import type { CommandEntry, CommandSnapshotSet } from "../src/contracts.ts"
import type { CommandEditor, CommandInvocation } from "../src/plugin.ts"

const entry = (name: string, overrides: Partial<CommandEntry> = {}): CommandEntry => ({
  name,
  canonicalPath: `/loc/root/A/.opencode/command/${name}.md`,
  description: `${name} command`,
  template: `# ${name}\n`,
  ...overrides,
})

const setOf = (...snapshots: CommandSnapshotSet["snapshots"]): CommandSnapshotSet => ({
  location: "/loc/root",
  snapshots,
})

const recordOf = (commands: readonly CommandEntry[], directory = "/loc/root/A"): CommandSnapshotSet["snapshots"][number] => ({
  scopeToken: "token-a",
  directory,
  commands,
})

const invocation = { sessionID: "ses_test", prompt: "go", delivery: "steer" } as unknown as CommandInvocation

const harness = () => {
  const added: { name: string; description?: string; execute: (input: CommandInvocation) => Promise<void> }[] = []
  const editor: CommandEditor = { add: (definition) => added.push(definition) }
  return { added, editor }
}

describe("command replay", () => {
  it("P1: adds every entry with its name and description, name-sorted", () => {
    const { added, editor } = harness()

    const diagnostics = applyCommands(
      editor,
      setOf(recordOf([entry("A:release"), entry("A:deploy")])),
      { lookup: () => undefined },
    )

    expect(added.map((definition) => definition.name)).toEqual(["A:deploy", "A:release"])
    expect(added.map((definition) => definition.description)).toEqual(["A:deploy command", "A:release command"])
    expect(added.every((definition) => typeof definition.execute === "function")).toBe(true)
    expect(diagnostics).toEqual([])
  })

  it("P2: registers nothing for an empty or undefined snapshot", () => {
    const { added, editor } = harness()

    const empty = applyCommands(editor, setOf(recordOf([])), { lookup: () => undefined })
    const missing = applyCommands(editor, undefined, { lookup: () => undefined })

    expect(added).toEqual([])
    expect(empty).toEqual([])
    expect(missing).toEqual([])
  })

  it("P3: never throws when add throws", () => {
    const { added } = harness()
    const editor: CommandEditor = {
      add: (definition) => {
        if (definition.name === "A:deploy") throw new Error("nope")
        added.push(definition)
      },
    }

    let diagnostics: readonly string[] = []
    expect(() => {
      diagnostics = applyCommands(editor, setOf(recordOf([entry("A:deploy"), entry("A:release")])), {
        lookup: () => undefined,
      })
    }).not.toThrow()

    expect(added.map((definition) => definition.name)).toEqual(["A:release"])
    expect(diagnostics).toEqual(["command-replay: A:deploy: nope"])
  })

  it("P4: the registered execute resolves the current snapshot, not the replayed one", async () => {
    const { added, editor } = harness()
    const replayed = setOf(recordOf([entry("A:deploy", { template: "A" })]))
    const live = setOf(recordOf([entry("A:deploy", { template: "B" })]))
    const seen: CommandTarget[] = []

    applyCommands(editor, replayed, {
      lookup: (name) => findCommand(live, name),
      execute: async (target) => {
        seen.push(target)
      },
    })

    const definition = added[0]
    expect(definition).toBeDefined()
    await definition!.execute(invocation)

    expect(seen.map((target) => target.entry.template)).toEqual(["B"])
    expect(seen[0]?.directory).toBe("/loc/root/A")
  })

  it("P5: an unknown name at invocation is a silent no-op", async () => {
    const { added, editor } = harness()
    let calls = 0

    applyCommands(editor, setOf(recordOf([entry("A:deploy")])), {
      lookup: () => undefined,
      execute: async () => {
        calls += 1
      },
    })

    await expect(added[0]!.execute(invocation)).resolves.toBeUndefined()
    expect(calls).toBe(0)
  })

  it("P6: a duplicate name is added once with one command-duplicate diagnostic", () => {
    const { added, editor } = harness()

    const diagnostics = applyCommands(
      editor,
      setOf(recordOf([entry("A:deploy", { template: "first" })]), recordOf([entry("A:deploy", { template: "second" })], "/loc/root/B")),
      { lookup: () => undefined },
    )

    expect(added).toHaveLength(1)
    expect(diagnostics).toEqual(["command-duplicate: A:deploy"])
  })
})
