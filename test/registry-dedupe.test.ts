import { realpathSync } from "node:fs"
import { symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { nativeIdFor, scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import { createRegistry, selectSuppressed } from "../src/registry.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { createRegistryFixture, registryEntry } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\n---\n# Deploy\n"

async function deployedFixture() {
  const fixture = await createRegistryFixture()
  await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
  return fixture
}

async function expectedIdOf(fixture: Awaited<ReturnType<typeof createRegistryFixture>>): Promise<string> {
  const subproject = await fixture.realpathOf("A")
  const skillPath = await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md")
  return `nested.${scopeTokenFor(subproject)}.${skillTokenFor("deploy", skillPath)}`
}

describe("native dedupe after reload", () => {
  it("suppresses a nested twin of a native entry with one extra reload", async () => {
    const fixture = await deployedFixture()

    try {
      const skillPath = await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md")
      const native = nativeSkill("native-deploy", skillPath)
      const fake = fakeContext([native], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      const sizes: number[] = []
      fake.onReload = () => sizes.push(fake.editor.list().length)

      const outcome = await registry.activate()
      const subproject = await fixture.realpathOf("A")

      expect(sizes).toEqual([2, 1])
      expect(outcome.reloads).toBe(2)
      expect(outcome.skills).toBe(0)
      expect(outcome.diagnostics).toContain(`dedupe: ${await expectedIdOf(fixture)}`)
      expect(fake.editor.list()).toEqual([native])
      expect(fake.storage.has(`nested/manifest/${scopeTokenFor(subproject)}`)).toBe(false)
      expect(fake.storage.has(`nested/subproject/${scopeTokenFor(subproject)}`)).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("never indexes a skill that sits inside a native root", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write(".claude/skills/x/SKILL.md", DOC)
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)

      const outcome = await registry.activate()

      expect(outcome.ok).toBe(true)
      expect(outcome.skills).toBe(0)
      expect(outcome.reloads).toBe(1)
      expect(outcome.diagnostics.some((entry) => entry.startsWith("dedupe:"))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it("leaves a foreign entry that already owns a nested id untouched", async () => {
    const fixture = await deployedFixture()

    try {
      const foreign = nativeSkill(await expectedIdOf(fixture))
      const fake = fakeContext([foreign], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)

      const outcome = await registry.activate()

      expect(outcome.reloads).toBe(1)
      expect(outcome.diagnostics.some((entry) => entry.startsWith("dedupe:"))).toBe(false)
      expect(fake.editor.list()).toEqual([foreign])
    } finally {
      await fixture.cleanup()
    }
  })

  it("restores the nested entry once the native twin is gone", async () => {
    const fixture = await deployedFixture()

    try {
      const skillPath = await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md")
      const native = nativeSkill("native-deploy", skillPath)
      const fake = fakeContext([native], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)

      const first = await registry.activate()
      fake.removeNative(native.id)
      const second = await registry.refresh()

      expect(first.reloads).toBe(2)
      expect(second.reloads).toBe(1)
      expect(fake.editor.get(await expectedIdOf(fixture))).toBeDefined()
      expect(second.skills).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the lowest id and diagnoses its path twin", () => {
    const shared = "/loc/x/.opencode/skills/deploy/SKILL.md"

    const suppressed = selectSuppressed(
      [
        registryEntry({ id: "nested.a.2", canonicalPath: shared }),
        registryEntry({ id: "nested.a.1", canonicalPath: shared }),
      ],
      new Set(),
    )

    expect(suppressed).toEqual(["nested.a.2"])
  })

  it("keeps the replayed snapshot and reports when list throws", async () => {
    const fixture = await deployedFixture()

    try {
      const skillPath = await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md")
      const fake = fakeContext([nativeSkill("native-deploy", skillPath)], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      fake.fail("skill.list", new Error("list down"))

      const outcome = await registry.activate()

      expect(outcome.ok).toBe(false)
      expect(outcome.reloads).toBe(1)
      expect(outcome.diagnostics).toContain("list: list down")
      expect(registry.snapshot.snapshots).toHaveLength(1)
      expect(fake.editor.list()).toHaveLength(2)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("symlinked location dedupe", () => {
  const CONFIG_ROOT = "pkg-a/.opencode/skills"
  const CONFIGURED = ["deploy/SKILL.md", "foo.md"]
  const OTHER = [
    "pkg-b/.opencode/skills/a/SKILL.md",
    "pkg-b/.opencode/skills/b/SKILL.md",
    "pkg-b/.opencode/skills/c/SKILL.md",
    "pkg-b/.opencode/skills/d/SKILL.md",
    "pkg-b/.opencode/skills/e/SKILL.md",
  ]

  const buildAliasFixture = async () => {
    const fixture = await createRegistryFixture()
    const alias = `${fixture.root}-alias`
    await symlink(fixture.root, alias, "dir")
    await fixture.write("opencode.json", JSON.stringify({ skills: [`./${CONFIG_ROOT}`] }))
    for (const rel of [...CONFIGURED.map((entry) => `${CONFIG_ROOT}/${entry}`), ...OTHER]) {
      await fixture.write(rel, DOC)
    }
    const natives = CONFIGURED.map((rel) =>
      nativeSkill(nativeIdFor(rel), join(alias, CONFIG_ROOT, rel)),
    )

    return { fixture, alias, natives }
  }

  it("settles to one entry per canonical path for an aliased location", async () => {
    const { fixture, alias, natives } = await buildAliasFixture()

    try {
      const fake = fakeContext(natives, { directory: alias })
      const sizes: number[] = []
      fake.onReload = () => sizes.push(fake.editor.list().length)

      const outcome = await createRegistry(fake.ctx).activate()

      const owners = new Map<string, string[]>()
      for (const entry of fake.editor.list()) {
        const canonical = realpathSync(String(entry.path))
        owners.set(canonical, [...(owners.get(canonical) ?? []), String(entry.id)])
      }

      expect(fake.editor.list()).toHaveLength(7)
      expect(owners.size).toBe(7)
      expect([...owners.values()].every((ids) => ids.length === 1)).toBe(true)
      expect(sizes).toEqual([9, 7])
      expect(outcome.reloads).toBe(2)
      expect(outcome.skills).toBe(5)
      expect(outcome.subprojects).toBe(1)
      expect(fake.editor.get("deploy")).toEqual(natives[0])
      expect(fake.editor.get("foo")).toEqual(natives[1])
      const survivors = fake.editor.list().filter((entry) => String(entry.id).startsWith("nested."))
      expect(survivors).toHaveLength(5)
      expect(survivors.every((entry) => !String(entry.path).includes("-alias"))).toBe(true)
      expect(outcome.diagnostics.filter((entry) => entry.startsWith("dedupe:"))).toHaveLength(2)
    } finally {
      await unlink(alias)
      await fixture.cleanup()
    }
  })

  it("suppresses on the same refresh when the host tier arrives late", async () => {
    const { fixture, alias, natives } = await buildAliasFixture()

    try {
      const fake = fakeContext(natives, { directory: alias })
      fake.hideNatives(8)
      const sizes: number[] = []
      fake.onReload = () => sizes.push(fake.editor.list().length)

      const outcome = await createRegistry(fake.ctx).activate()

      const owners = new Map<string, string[]>()
      for (const entry of fake.editor.list()) {
        const canonical = realpathSync(String(entry.path))
        owners.set(canonical, [...(owners.get(canonical) ?? []), String(entry.id)])
      }

      expect(sizes).toEqual([9, 7])
      expect(outcome.reloads).toBe(2)
      expect(fake.editor.list()).toHaveLength(7)
      expect(owners.size).toBe(7)
      expect([...owners.values()].every((ids) => ids.length === 1)).toBe(true)
      expect(fake.editor.get("deploy")).toEqual(natives[0])
      expect(fake.editor.get("foo")).toEqual(natives[1])
      expect(outcome.diagnostics.filter((entry) => entry.startsWith("dedupe:"))).toHaveLength(2)
      expect(outcome.diagnostics.some((entry) => entry.startsWith("dedupe-settle-timeout:"))).toBe(false)
    } finally {
      await unlink(alias)
      await fixture.cleanup()
    }
  })
})

describe("dedupe path canonicalisation edges", () => {
  it("leaves a native entry outside the location untouched", async () => {
    const fixture = await deployedFixture()
    const outside = await createRegistryFixture()

    try {
      await outside.write("skills/outside/SKILL.md", DOC)
      const native = nativeSkill("outside", await outside.realpathOf("skills/outside/SKILL.md"))
      const fake = fakeContext([native], { directory: fixture.root })

      const outcome = await createRegistry(fake.ctx).activate()

      expect(outcome.ok).toBe(true)
      expect(outcome.reloads).toBe(1)
      expect(fake.editor.get("outside")).toEqual(native)
      expect(outcome.diagnostics.some((entry) => entry.startsWith("dedupe:"))).toBe(false)
      expect(fake.editor.list()).toHaveLength(2)
    } finally {
      await outside.cleanup()
      await fixture.cleanup()
    }
  })

  it("falls back to the raw path when realpath fails", async () => {
    const fixture = await deployedFixture()

    try {
      const ghost = nativeSkill("ghost", join(fixture.root, "ghost", "SKILL.md"))
      const fake = fakeContext([ghost], { directory: fixture.root })

      const outcome = await createRegistry(fake.ctx).activate()

      expect(outcome.ok).toBe(true)
      expect(outcome.reloads).toBe(1)
      expect(fake.editor.get("ghost")).toEqual(ghost)
      expect(outcome.diagnostics.some((entry) => entry.startsWith("dedupe:"))).toBe(false)
      expect(fake.editor.list()).toHaveLength(2)
    } finally {
      await fixture.cleanup()
    }
  })
})
