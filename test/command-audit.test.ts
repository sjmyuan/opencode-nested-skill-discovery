import { describe, expect, it } from "vitest"
import { auditReloadedCommands, EMPTY_NATIVE_COMMANDS, publishedCommands } from "../src/command-audit.ts"
import type { NativeCommandNameIndex } from "../src/command-native.ts"
import { createShadowTracker, type ListedCommand, type ShadowTracker } from "../src/command-shadow.ts"
import type { CommandEntry, CommandSnapshotSet } from "../src/contracts.ts"

const entry = (name: string, description?: string): CommandEntry => ({
  name,
  canonicalPath: `/ws/${name}.md`,
  ...(description === undefined ? {} : { description }),
  template: `# ${name}`,
})

const snapshotOf = (...groups: readonly (readonly CommandEntry[])[]): CommandSnapshotSet => ({
  location: "/ws",
  snapshots: groups.map((commands, index) => ({
    scopeToken: `scope-${index}`,
    directory: `/ws/${index}`,
    commands,
  })),
})

const nativeOf = (...names: readonly string[]): NativeCommandNameIndex => ({
  names,
  complete: true,
  diagnostics: [],
})

const listing =
  (...data: readonly ListedCommand[]) =>
  async () => ({ data })

describe("publishedCommands", () => {
  it("C1: flattens records in snapshot order and gives [] for an empty set", async () => {
    const snapshot = snapshotOf([entry("A:deploy"), entry("A:release")], [entry("B:deploy")])

    expect(publishedCommands(snapshot).map((command) => command.name)).toEqual([
      "A:deploy",
      "A:release",
      "B:deploy",
    ])
    expect(publishedCommands({ location: "/ws", snapshots: [] })).toEqual([])
  })

  it("C7: the published set is exactly the snapshot's entries, never normalised", () => {
    const commands = [entry("A:deploy", "ours"), entry("mcp:prompt")]
    const snapshot = snapshotOf(commands)

    expect(publishedCommands(snapshot)).toEqual(commands)
    expect(publishedCommands(snapshot).map((command) => command.name)).toEqual(["A:deploy", "mcp:prompt"])
  })
})

describe("auditReloadedCommands", () => {
  it("C2: a description mismatch is shadowed and reported once, in published order", async () => {
    const tracker = createShadowTracker()
    const snapshot = snapshotOf([entry("A:deploy", "ours"), entry("A:release", "ours")])
    const list = listing(
      { name: "A:deploy", description: "native" },
      { name: "A:release", description: "native" },
    )

    const first = await auditReloadedCommands({ snapshot, list, native: nativeOf(), tracker })
    const second = await auditReloadedCommands({ snapshot, list, native: nativeOf(), tracker })

    expect(first.shadowed).toEqual(["A:deploy", "A:release"])
    expect(first.diagnostics).toEqual(["native-shadow-audit: A:deploy", "native-shadow-audit: A:release"])
    expect(second.shadowed).toEqual(["A:deploy", "A:release"])
    expect(second.diagnostics).toEqual([])
  })

  it("C3: a listed name no published entry explains is foreign and silent", async () => {
    const tracker = createShadowTracker()
    const snapshot = snapshotOf([entry("A:deploy", "ours")])

    const outcome = await auditReloadedCommands({
      snapshot,
      list: listing({ name: "A:deploy", description: "ours" }, { name: "btw" }, { name: "mcp:prompt" }),
      native: nativeOf(),
      tracker,
    })

    expect(outcome.foreign).toEqual(["btw", "mcp:prompt"])
    expect(outcome.shadowed).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it("C4: a published name missing from the listing is absent, never shadowed", async () => {
    const tracker = createShadowTracker()
    const snapshot = snapshotOf([entry("A:deploy", "ours")])

    const outcome = await auditReloadedCommands({
      snapshot,
      list: listing({ name: "btw" }),
      native: nativeOf(),
      tracker,
    })

    expect(outcome.absent).toEqual(["A:deploy"])
    expect(outcome.shadowed).toEqual([])
    expect(outcome.diagnostics).toEqual(["command-absent: A:deploy"])
  })

  it("C5: the tracker keeps a denial while the forwarded native index still holds the name", async () => {
    const shadowed = snapshotOf([entry("A:deploy", "ours")])
    const shadow = (tracker: ShadowTracker) =>
      auditReloadedCommands({
        snapshot: shadowed,
        list: listing({ name: "A:deploy", description: "native" }),
        native: nativeOf("A:deploy"),
        tracker,
      })

    const held = createShadowTracker()
    await shadow(held)
    const kept = await auditReloadedCommands({
      snapshot: snapshotOf(),
      list: listing(),
      native: nativeOf("A:deploy"),
      tracker: held,
    })
    const denied = held.drop(publishedCommands(shadowed), nativeOf())

    const control = createShadowTracker()
    await shadow(control)
    await auditReloadedCommands({
      snapshot: snapshotOf(),
      list: listing(),
      native: nativeOf(),
      tracker: control,
    })
    const returned = control.drop(publishedCommands(shadowed), nativeOf())

    expect(kept.diagnostics).toEqual([])
    expect(denied.kept).toEqual([])
    expect(denied.diagnostics).toEqual([])
    expect(returned.kept.map((command) => command.name)).toEqual(["A:deploy"])
  })

  it("C6: EMPTY_NATIVE_COMMANDS is empty and frozen", () => {
    expect(EMPTY_NATIVE_COMMANDS.names).toEqual([])
    expect(EMPTY_NATIVE_COMMANDS.complete).toBe(true)
    expect(EMPTY_NATIVE_COMMANDS.diagnostics).toEqual([])
    expect(Object.isFrozen(EMPTY_NATIVE_COMMANDS)).toBe(true)
    expect(Object.isFrozen(EMPTY_NATIVE_COMMANDS.names)).toBe(true)
    expect(Object.isFrozen(EMPTY_NATIVE_COMMANDS.diagnostics)).toBe(true)
  })

  it("C8: a rejecting list propagates instead of being swallowed", async () => {
    const tracker = createShadowTracker()

    await expect(
      auditReloadedCommands({
        snapshot: snapshotOf([entry("A:deploy")]),
        list: async () => {
          throw new Error("list down")
        },
        native: EMPTY_NATIVE_COMMANDS,
        tracker,
      }),
    ).rejects.toThrow("list down")
  })
})
