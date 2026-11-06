import { describe, expect, it } from "vitest"
import { ID_PREFIX } from "../src/contracts.ts"
import { scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import { setup } from "../src/plugin.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\ndescription: Deploys releases.\n---\n# Deploy\n\nDeploys releases.\n"

async function deployedFixture() {
  const fixture = await createRegistryFixture()
  await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
  return fixture
}

describe("registry controller wiring", () => {
  it("keeps createRegistry free of I/O and registration", () => {
    const fake = fakeContext()

    const registry = createRegistry(fake.ctx)

    expect(fake.transforms).toHaveLength(0)
    expect(fake.reloadCalls).toBe(0)
    expect(fake.storage.size).toBe(0)
    expect(registry.snapshot.snapshots).toEqual([])
  })

  it("registers one transform from setup and disposes it once", async () => {
    const fixture = await createRegistryFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const cleanup = await setup(fake.ctx)

      expect(fake.transforms).toHaveLength(1)
      expect(cleanup).toBeTypeOf("function")
      if (typeof cleanup !== "function") return

      await cleanup()
      expect(fake.disposeCalls).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("scans, assembles, persists, and replays one nested skill", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      const outcome = await registry.activate()

      const root = await fixture.realpathOf(".")
      const subproject = await fixture.realpathOf("A")
      const skillPath = await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md")
      const expectedId = `${ID_PREFIX}${scopeTokenFor(subproject)}.${skillTokenFor("deploy", skillPath)}`
      const entry = registry.snapshot.snapshots[0]?.skills[0]

      expect(outcome.ok).toBe(true)
      expect(outcome.skills).toBe(1)
      expect(outcome.subprojects).toBe(1)
      expect(registry.location).toBe(root)
      expect(registry.snapshot.location).toBe(root)
      expect(entry?.id).toBe(expectedId)
      expect(entry?.name).toBe("A/deploy")
      expect(entry?.canonicalPath).toBe(skillPath)
      expect(fake.editor.get(expectedId)?.content).toContain("# Deploy")
      expect(fake.storage.get(`nested/manifest/${scopeTokenFor(subproject)}`)).toBeDefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it("swaps the snapshot before reloading", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      let observed = -1
      fake.onReload = () => {
        observed = registry.snapshot.snapshots.length
      }

      const outcome = await registry.activate()

      expect(outcome.reloads).toBe(1)
      expect(observed).toBe(1)
      expect(fake.reloadCalls).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("replaces the snapshot and bumps the version on each refresh", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      const first = await registry.activate()
      const firstSnapshot = registry.snapshot
      const second = await registry.refresh()

      expect(registry.snapshot).not.toBe(firstSnapshot)
      expect(first.version).toBeTypeOf("number")
      expect(second.version).toBeGreaterThan(first.version ?? 0)
      expect(fake.storage.get("nested/manifest/version")).toBe(second.version)
      expect(fake.reloadCalls).toBe(2)
    } finally {
      await fixture.cleanup()
    }
  })

  it("shares one in-flight refresh between concurrent callers", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)

      const [first, second] = await Promise.all([registry.refresh(), registry.refresh()])

      expect(first).toBe(second)
      expect(fake.reloadCalls).toBe(1)
      expect(fake.transforms).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("registers once across repeated activation", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)

      const first = await registry.activate()
      const second = await registry.activate()

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(fake.transforms).toHaveLength(1)
      expect(fake.reloadCalls).toBe(2)
    } finally {
      await fixture.cleanup()
    }
  })

  it("yields an empty registry for a location with no skill roots", async () => {
    const fixture = await createRegistryFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)

      const outcome = await registry.activate()

      expect(outcome.ok).toBe(true)
      expect(outcome.skills).toBe(0)
      expect(outcome.subprojects).toBe(0)
      expect(outcome.reloads).toBe(1)
      expect(registry.snapshot.snapshots).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("stops refreshing after disposal without touching storage or the editor", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      await registry.activate()
      const reloads = fake.reloadCalls
      const keys = [...fake.storage.keys()].sort()

      await registry.dispose()
      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.diagnostics).toEqual(["disposed"])
      expect(fake.reloadCalls).toBe(reloads)
      expect([...fake.storage.keys()].sort()).toEqual(keys)
    } finally {
      await fixture.cleanup()
    }
  })
})
