import type { Skill } from "@opencode/plugin"
import { describe, expect, it, vi } from "vitest"
import type { RegistrySnapshot } from "../src/contracts.ts"
import type { SkillEditor } from "../src/plugin.ts"
import { applyRegistry } from "../src/replay.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { registryEntry } from "./support/registry-fixtures.ts"

const snapshotOf = (...skills: RegistrySnapshot["snapshots"][number]["skills"]): RegistrySnapshot => ({
  location: "/loc/root",
  snapshots: [{ scopeToken: "token-a", directory: "/loc/root/A", skills }],
})

const ids = (editor: SkillEditor): string[] => editor.list().map((entry) => String(entry.id))

describe("registry replay", () => {
  it("leaves a seeded native entry byte-identical", () => {
    const fake = fakeContext([nativeSkill("native-alpha")])
    const seed = fake.editor.list()[0]

    applyRegistry(fake.editor, snapshotOf(registryEntry({ id: "nested.a.1" })))

    expect(fake.editor.list()[0]).toEqual(seed)
    expect(fake.editor.list()).toHaveLength(2)
  })

  it("adds only the snapshot union in ascending id order", () => {
    const fake = fakeContext([nativeSkill("native-alpha")])
    const snapshot: RegistrySnapshot = {
      location: "/loc/root",
      snapshots: [
        {
          scopeToken: "token-b",
          directory: "/loc/root/B",
          skills: [registryEntry({ id: "nested.b.2" }), registryEntry({ id: "nested.b.1" })],
        },
        {
          scopeToken: "token-a",
          directory: "/loc/root/A",
          skills: [registryEntry({ id: "nested.a.1" })],
        },
      ],
    }

    const diagnostics = applyRegistry(fake.editor, snapshot)

    expect(diagnostics).toEqual([])
    expect(ids(fake.editor)).toEqual(["native-alpha", "nested.a.1", "nested.b.1", "nested.b.2"])
  })

  it("writes every skill field and the branded id", () => {
    const fake = fakeContext()
    const entry = registryEntry({
      id: "nested.a.1",
      canonicalPath: "/private/loc/A/.opencode/skills/deploy/SKILL.md",
      name: "A/deploy",
      description: "Deploys releases.",
      autoinvoke: false,
      content: "# Deploy\n",
    })

    applyRegistry(fake.editor, snapshotOf(entry))

    expect(fake.editor.get("nested.a.1")).toEqual({
      id: "nested.a.1",
      name: "A/deploy",
      description: "Deploys releases.",
      autoinvoke: false,
      path: "/private/loc/A/.opencode/skills/deploy/SKILL.md",
      content: "# Deploy\n",
    })
  })

  it("is idempotent across replays", () => {
    const fake = fakeContext()
    const snapshot = snapshotOf(registryEntry({ id: "nested.a.1" }))

    applyRegistry(fake.editor, snapshot)
    applyRegistry(fake.editor, snapshot)

    expect(ids(fake.editor)).toEqual(["nested.a.1"])
  })

  it("leaves a foreign entry that owns a nested id untouched", () => {
    const foreign = nativeSkill("nested.a.1")
    const fake = fakeContext([foreign])

    const diagnostics = applyRegistry(fake.editor, snapshotOf(registryEntry({ id: "nested.a.1" })))

    expect(fake.editor.list()).toEqual([foreign])
    expect(diagnostics).toEqual([])
  })

  it("keeps adding after one add throws", () => {
    const fake = fakeContext()
    const original = fake.editor
    const editor = {
      ...original,
      add: (skill: Skill.Info) => {
        if (skill.id === "nested.a.2") throw new Error("add down")
        original.add(skill)
      },
    } as SkillEditor

    const diagnostics = applyRegistry(
      editor,
      snapshotOf(
        registryEntry({ id: "nested.a.1" }),
        registryEntry({ id: "nested.a.2" }),
        registryEntry({ id: "nested.a.3" }),
      ),
    )

    expect(ids(editor)).toEqual(["nested.a.1", "nested.a.3"])
    expect(diagnostics).toEqual(["replay: nested.a.2: add down"])
  })

  it("skips only the entry whose lookup throws", () => {
    const fake = fakeContext()
    const original = fake.editor
    const editor = {
      ...original,
      get: (id: string) => {
        if (id === "nested.a.2") throw new Error("get down")
        return original.get(id)
      },
    } as SkillEditor

    const diagnostics = applyRegistry(
      editor,
      snapshotOf(registryEntry({ id: "nested.a.1" }), registryEntry({ id: "nested.a.2" })),
    )

    expect(ids(editor)).toEqual(["nested.a.1"])
    expect(diagnostics).toEqual(["replay: nested.a.2: get down"])
  })

  it("is a no-op for an undefined or empty snapshot", () => {
    const fake = fakeContext()
    const empty: RegistrySnapshot = { location: "/loc/root", snapshots: [] }

    expect(applyRegistry(fake.editor, undefined)).toEqual([])
    expect(applyRegistry(fake.editor, empty)).toEqual([])
    expect(fake.editor.list()).toEqual([])
  })

  it("never removes an entry", () => {
    const fake = fakeContext([nativeSkill("native-alpha")])
    const remove = vi.spyOn(fake.editor, "remove")

    applyRegistry(fake.editor, snapshotOf(registryEntry({ id: "nested.a.1" })))

    expect(remove).not.toHaveBeenCalled()
  })
})
