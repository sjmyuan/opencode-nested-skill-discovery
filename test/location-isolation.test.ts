import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { ManifestRecord, Snapshot } from "../src/contracts.ts"
import { locationTokenFor, scopeTokenFor } from "../src/indexer.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\ndescription: Deploys releases.\n---\n# Deploy\n"

const skillKey = (location: string, kind: "manifest" | "subproject", scope: string): string =>
  `nested/${locationTokenFor(location)}/${kind}/${scope}`

const versionKey = (location: string): string => `nested/${locationTokenFor(location)}/manifest/version`

interface TwoLocations {
  readonly fixture: Awaited<ReturnType<typeof createRegistryFixture>>
  readonly shared: Map<string, Schema.Json>
  readonly realRoot: string
  readonly realA: string
  readonly scope: string
  readonly outer: ReturnType<typeof createRegistry>
  readonly inner: ReturnType<typeof createRegistry>
  cleanup(): Promise<void>
}

/** `A/B` is a subproject of both locations, so both index the very same directory. */
async function twoLocations(): Promise<TwoLocations> {
  const fixture = await createRegistryFixture()
  await fixture.write("A/B/.opencode/skills/deploy/SKILL.md", DOC)
  await fixture.write("B/.opencode/skills/build/SKILL.md", DOC)

  const realRoot = fixture.realRoot
  const realA = await fixture.realpathOf("A")
  const shared = new Map<string, Schema.Json>()
  const outer = createRegistry(fakeContext([], { directory: realRoot, storageMap: shared }).ctx)
  const inner = createRegistry(fakeContext([], { directory: realA, storageMap: shared }).ctx)

  return {
    fixture,
    shared,
    realRoot,
    realA,
    scope: scopeTokenFor(await fixture.realpathOf("A/B")),
    outer,
    inner,
    cleanup: () => fixture.cleanup(),
  }
}

const manifestOf = (store: Map<string, Schema.Json>, key: string): ManifestRecord =>
  store.get(key) as unknown as ManifestRecord

const cacheOf = (store: Map<string, Schema.Json>, key: string): Snapshot => store.get(key) as unknown as Snapshot

describe("locations sharing one storage", () => {
  it("keeps one record per location for the directory they share", async () => {
    const context = await twoLocations()

    try {
      await context.outer.refresh()
      await context.inner.refresh()

      const outerManifestKey = skillKey(context.realRoot, "manifest", context.scope)
      const innerManifestKey = skillKey(context.realA, "manifest", context.scope)

      expect(context.shared.has(outerManifestKey)).toBe(true)
      expect(context.shared.has(innerManifestKey)).toBe(true)
      expect(outerManifestKey).not.toBe(innerManifestKey)
      expect(context.shared.has(skillKey(context.realRoot, "subproject", context.scope))).toBe(true)
      expect(context.shared.has(skillKey(context.realA, "subproject", context.scope))).toBe(true)

      const outerManifest = manifestOf(context.shared, outerManifestKey)
      const innerManifest = manifestOf(context.shared, innerManifestKey)
      expect(outerManifest.directory).toBe(await context.fixture.realpathOf("A/B"))
      expect(innerManifest.directory).toBe(outerManifest.directory)
      expect(outerManifest.entries.map((entry) => entry.id)).toEqual(innerManifest.entries.map((entry) => entry.id))
      expect(outerManifest.entries).toHaveLength(1)
      expect(outerManifest.manifestVersion).toBe(context.shared.get(versionKey(context.realRoot)))
      expect(innerManifest.manifestVersion).toBe(context.shared.get(versionKey(context.realA)))

      expect(cacheOf(context.shared, skillKey(context.realRoot, "subproject", context.scope)).skills).toHaveLength(1)
      expect(cacheOf(context.shared, skillKey(context.realA, "subproject", context.scope)).skills).toHaveLength(1)
      expect(context.shared.has(`nested/manifest/${context.scope}`)).toBe(false)
      expect(context.shared.has(`nested/subproject/${context.scope}`)).toBe(false)
    } finally {
      await context.cleanup()
    }
  })

  it("leaves the other location's record and counter alone when one prunes", async () => {
    const context = await twoLocations()

    try {
      await context.outer.refresh()
      await context.inner.refresh()

      const outerKey = skillKey(context.realRoot, "manifest", context.scope)
      const before = structuredClone(manifestOf(context.shared, outerKey))
      const outerVersion = context.shared.get(versionKey(context.realRoot))
      const innerVersion = Number(context.shared.get(versionKey(context.realA)))

      await context.fixture.remove("A/B/.opencode/skills/deploy")
      await context.inner.refresh()

      expect(context.shared.has(skillKey(context.realA, "manifest", context.scope))).toBe(false)
      expect(context.shared.has(skillKey(context.realA, "subproject", context.scope))).toBe(false)
      expect(manifestOf(context.shared, outerKey)).toEqual(before)
      expect(context.shared.get(versionKey(context.realRoot))).toBe(outerVersion)
      expect(Number(context.shared.get(versionKey(context.realA)))).toBeGreaterThan(innerVersion)
    } finally {
      await context.cleanup()
    }
  })

  it("moves only its own counter across repeated refreshes", async () => {
    const context = await twoLocations()

    try {
      await context.outer.refresh()
      await context.inner.refresh()

      const outerVersion = context.shared.get(versionKey(context.realRoot))
      const innerFirst = Number(context.shared.get(versionKey(context.realA)))

      await context.inner.refresh()
      await context.inner.refresh()

      expect(context.shared.get(versionKey(context.realRoot))).toBe(outerVersion)
      expect(Number(context.shared.get(versionKey(context.realA)))).toBeGreaterThan(innerFirst)
    } finally {
      await context.cleanup()
    }
  })

  it("prunes its own stale tokens and never a foreign token", async () => {
    const context = await twoLocations()

    try {
      await context.outer.refresh()

      const staleKey = skillKey(context.realRoot, "manifest", "gone-0000dead")
      const foreignKey = skillKey("/somewhere/else", "manifest", context.scope)
      const disappeared = join(context.realRoot, "Gone")
      const foreign = {
        manifestVersion: 1,
        scopeToken: context.scope,
        directory: join(disappeared, "Inner"),
        entries: [],
      }
      context.shared.set(staleKey, {
        manifestVersion: 1,
        scopeToken: "gone-0000dead",
        directory: join(disappeared, "x"),
        entries: [],
      })
      context.shared.set(foreignKey, foreign)

      await context.outer.refresh()

      expect(context.shared.has(staleKey)).toBe(false)
      expect(context.shared.get(foreignKey)).toEqual(foreign)
    } finally {
      await context.cleanup()
    }
  })

  it("keys a symlinked location by the directory it resolves to", async () => {
    const fixture = await createRegistryFixture()
    const linkRoot = await mkdtemp(join(tmpdir(), "nested-location-link-"))

    try {
      await fixture.write("A/B/.opencode/skills/deploy/SKILL.md", DOC)
      const link = join(linkRoot, "link")
      await symlink(fixture.realRoot, link, "dir")

      const shared = new Map<string, Schema.Json>()
      await createRegistry(fakeContext([], { directory: link, storageMap: shared }).ctx).refresh()

      const scope = scopeTokenFor(await fixture.realpathOf("A/B"))
      expect(shared.has(skillKey(fixture.realRoot, "manifest", scope))).toBe(true)
      expect(shared.has(versionKey(fixture.realRoot))).toBe(true)
      expect(shared.has(skillKey(link, "manifest", scope))).toBe(false)
      expect([...shared.keys()].some((key) => key.startsWith(`nested/${locationTokenFor(link)}/`))).toBe(false)
    } finally {
      await fixture.cleanup()
      await rm(linkRoot, { recursive: true, force: true })
    }
  })
})
