import { rm } from "node:fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { STORAGE_KEYS } from "../src/contracts.ts"
import { locationTokenFor, scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import { setup } from "../src/plugin.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const scanControl = vi.hoisted(() => ({ failure: undefined as Error | undefined, diagnostics: 0 }))
const indexControl = vi.hoisted(() => ({ failure: undefined as Error | undefined }))

vi.mock("../src/scan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scan.ts")>()
  return {
    ...actual,
    scanSkills: async (options: Parameters<typeof actual.scanSkills>[0]) => {
      if (scanControl.failure !== undefined) throw scanControl.failure
      const result = await actual.scanSkills(options)
      if (scanControl.diagnostics === 0) return result
      return {
        ...result,
        diagnostics: Array.from({ length: scanControl.diagnostics }, (_, index) => `scan-diag-${index}`),
      }
    },
  }
})

vi.mock("../src/indexer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/indexer.ts")>()
  return {
    ...actual,
    indexCandidates: async (...args: Parameters<typeof actual.indexCandidates>) => {
      if (indexControl.failure !== undefined) throw indexControl.failure
      return actual.indexCandidates(...args)
    },
  }
})

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

beforeEach(() => {
  scanControl.failure = undefined
  scanControl.diagnostics = 0
  indexControl.failure = undefined
})

describe("failure retention", () => {
  it("keeps the previous snapshot when the scan fails", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      await registry.activate()
      const stable = registry.snapshot
      scanControl.failure = new Error("scan down")

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.diagnostics).toEqual(["scan: scan down"])
      expect(registry.snapshot).toBe(stable)
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the previous snapshot when the index fails", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      await registry.activate()
      const stable = registry.snapshot
      indexControl.failure = new Error("index down")

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.diagnostics).toEqual(["index: index down"])
      expect(registry.snapshot).toBe(stable)
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the previous snapshot when the version read fails", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      const first = await registry.activate()
      const stable = registry.snapshot
      fake.fail("storage.get", new Error("get down"))

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.diagnostics).toEqual(["version: get down"])
      expect(registry.snapshot).toBe(stable)
      expect(fake.storage.get(STORAGE_KEYS.version(locationTokenFor(fixture.realRoot)))).toBe(first.version)
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the previous snapshot when a manifest write fails", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      const first = await registry.activate()
      const stable = registry.snapshot
      const token = scopeTokenFor(await fixture.realpathOf("A"))
      fake.failKey(STORAGE_KEYS.manifest(locationTokenFor(fixture.realRoot), token), new Error("manifest down"))

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.diagnostics).toEqual([`manifest: ${token}: manifest down`])
      expect(registry.snapshot).toBe(stable)
      expect(fake.storage.get(STORAGE_KEYS.version(locationTokenFor(fixture.realRoot)))).toBeGreaterThan(
        first.version ?? 0,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the previous snapshot when a snapshot-cache write fails", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      await registry.activate()
      const stable = registry.snapshot
      const token = scopeTokenFor(await fixture.realpathOf("A"))
      fake.failKey(STORAGE_KEYS.subproject(locationTokenFor(fixture.realRoot), token), new Error("cache down"))

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.diagnostics).toEqual([`snapshot: ${token}: cache down`])
      expect(registry.snapshot).toBe(stable)
      expect(fake.storage.get(STORAGE_KEYS.manifest(locationTokenFor(fixture.realRoot), token))).toBeDefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it("swaps and reports when pruning fails", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      await registry.activate()
      const stable = registry.snapshot
      fake.fail("storage.scan", new Error("scan down"))

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(true)
      expect(outcome.diagnostics).toContain("prune: scan down")
      expect(registry.snapshot).not.toBe(stable)
      expect(registry.snapshot.snapshots).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the swapped snapshot when reload fails", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      await registry.activate()
      const stable = registry.snapshot
      fake.fail("skill.reload", new Error("reload down"))

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.diagnostics).toEqual(["reload: reload down"])
      expect(registry.snapshot).not.toBe(stable)
      expect(registry.snapshot.snapshots).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("isolates a throwing add inside the transform", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      const target = await expectedIdOf(fixture)
      const originalAdd = fake.editor.add
      vi.spyOn(fake.editor, "add").mockImplementation((skill) => {
        if (String(skill.id) === target) throw new Error("add down")
        originalAdd(skill)
      })

      const first = await registry.activate()
      const second = await registry.refresh()

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(second.diagnostics.some((entry) => entry.startsWith("replay:"))).toBe(true)
      expect(fake.editor.get(target)).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it("skips only the entry whose lookup throws", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("B/.opencode/skills/release/SKILL.md", DOC)
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      const target = await expectedIdOf(fixture)
      const originalGet = fake.editor.get
      vi.spyOn(fake.editor, "get").mockImplementation((id) => {
        if (String(id) === target) throw new Error("get down")
        return originalGet(id)
      })

      const first = await registry.activate()
      const second = await registry.refresh()

      expect(first.ok).toBe(true)
      expect(second.diagnostics).toContain(`replay: ${target}: get down`)
      expect(fake.editor.list()).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("resolves setup to a cleanup when storage rejects everything", async () => {
    const fake = fakeContext()
    for (const target of ["storage.get", "storage.set", "storage.remove", "storage.scan"] as const) {
      fake.fail(target, new Error("down"))
    }

    const cleanup = await setup(fake.ctx)

    expect(cleanup).toBeTypeOf("function")
    expect(fake.transforms).toHaveLength(1)
    if (typeof cleanup === "function") await cleanup()
  })

  it("caps the diagnostics list at one page plus a summary", async () => {
    const fixture = await createRegistryFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      scanControl.diagnostics = 250

      const outcome = await registry.activate()

      expect(outcome.diagnostics).toHaveLength(200)
      expect(outcome.diagnostics.at(-1)).toMatch(/^truncated: \d+ more diagnostics$/)
    } finally {
      await fixture.cleanup()
    }
  })

  it("swaps an empty registry when the location disappears", async () => {
    const fixture = await deployedFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root })
      const registry = createRegistry(fake.ctx)
      await registry.activate()
      await rm(fixture.root, { recursive: true, force: true })

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.skills).toBe(0)
      expect(outcome.diagnostics[0]).toBe(`scan: ${registry.location} is not a directory`)
      expect(registry.snapshot.snapshots).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })
})
