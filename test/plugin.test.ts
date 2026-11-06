import { describe, expect, it, vi } from "vitest"
import type { RegistrySnapshot } from "../src/contracts.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

vi.mock("@opencode/plugin", () => ({ Plugin: { define: (plugin: unknown) => plugin } }))

const entry = await import("../index.ts")
const core = await import("../src/plugin.ts")

const DOC = "---\nname: deploy\n---\n# Deploy\n"
const EXTRA_DOC = "---\nname: extra\n---\n# Extra\n"

describe("plugin definition", () => {
  it("default-exports only the id and setup", () => {
    expect(Object.keys(entry.default).sort()).toEqual(["id", "setup"])
    expect(entry.default.id).toBe("nested-skill-discovery")
  })

  it("registers exactly one skill transform and one prompt hook, and disposes both once", async () => {
    const fixture = await createRegistryFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const cleanup = await entry.default.setup(fake.ctx)

      expect(fake.transforms).toHaveLength(1)
      expect(fake.hookRegistrations).toBe(1)
      expect(cleanup).toBeTypeOf("function")
      if (typeof cleanup !== "function") return

      await cleanup()
      expect(fake.disposeCalls).toBe(1)
      expect(fake.hookDisposeCalls).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refreshes from the production watcher without registering a second transform", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      const fake = fakeContext([], { directory: fixture.root })
      const cleanup = await entry.default.setup(fake.ctx)
      if (typeof cleanup !== "function") return

      try {
        const reloads = fake.reloadCalls
        await fixture.write("A/.opencode/skills/extra/SKILL.md", EXTRA_DOC)

        await vi.waitFor(() => expect(fake.reloadCalls).toBeGreaterThan(reloads), {
          timeout: 5000,
          interval: 50,
        })

        expect(fake.transforms).toHaveLength(1)
        expect(fake.hookRegistrations).toBe(1)
        expect(fake.editor.list().map((skill) => String(skill.name))).toContain("A/extra")
      } finally {
        await cleanup()
      }
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("snapshot replay", () => {
  it("adds the nested entry next to an untouched native entry", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      const seed = nativeSkill("native-alpha")
      const fake = fakeContext([seed], { directory: fixture.root })
      await entry.default.setup(fake.ctx)

      const listed = fake.editor.list()

      expect(listed).toHaveLength(2)
      expect(listed[0]).toEqual(seed)
      expect(listed[1]?.name).toBe("A/deploy")
      expect(String(listed[1]?.id).startsWith("nested.")).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("tolerates an undefined snapshot", () => {
    const fake = fakeContext()

    expect(() => core.applySnapshot(fake.editor, undefined)).not.toThrow()
  })

  it("is a no-op for an empty registry snapshot", () => {
    const fake = fakeContext([nativeSkill("native-alpha")])
    const before = fake.editor.list().map((skill) => ({ ...skill }))
    const empty: RegistrySnapshot = { location: "/loc/root", snapshots: [] }

    core.applySnapshot(fake.editor, empty)

    expect(fake.editor.list()).toEqual(before)
  })

  it("freezes the empty snapshot", () => {
    expect(Object.isFrozen(core.EMPTY_SNAPSHOT)).toBe(true)
    expect(Object.isFrozen(core.EMPTY_SNAPSHOT.skills)).toBe(true)
    expect(core.EMPTY_SNAPSHOT.skills).toHaveLength(0)
  })
})
