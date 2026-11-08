import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  LEGACY_STORAGE_PREFIXES,
  STORAGE_FORMAT,
  STORAGE_FORMAT_KEY,
  type CommandEntry,
  type CommandSnapshot,
  type ManifestRecord,
  type Snapshot,
} from "../src/contracts.ts"
import { locationTokenFor, scopeTokenFor } from "../src/indexer.ts"
import { persistCommands } from "../src/manifest.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\ndescription: Deploys releases.\n---\n# Deploy\n"

const skillKey = (location: string, kind: "manifest" | "subproject", scope: string): string =>
  `nested/${locationTokenFor(location)}/${kind}/${scope}`

const versionKey = (location: string): string => `nested/${locationTokenFor(location)}/manifest/version`

const commandKey = (location: string, suffix: string): string =>
  `nested/${locationTokenFor(location)}/commands/${suffix}`

interface TwoLocations {
  readonly fixture: Awaited<ReturnType<typeof createRegistryFixture>>
  readonly shared: Map<string, Schema.Json>
  readonly realRoot: string
  readonly realA: string
  readonly scope: string
  readonly outer: ReturnType<typeof createRegistry>
  readonly inner: ReturnType<typeof createRegistry>
  readonly outerStore: ReturnType<typeof fakeContext>["ctx"]["storage"]
  readonly innerStore: ReturnType<typeof fakeContext>["ctx"]["storage"]
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
  const outerFake = fakeContext([], { directory: realRoot, storageMap: shared })
  const innerFake = fakeContext([], { directory: realA, storageMap: shared })
  const outer = createRegistry(outerFake.ctx)
  const inner = createRegistry(innerFake.ctx)

  return {
    fixture,
    shared,
    realRoot,
    realA,
    scope: scopeTokenFor(await fixture.realpathOf("A/B")),
    outer,
    inner,
    outerStore: outerFake.ctx.storage,
    innerStore: innerFake.ctx.storage,
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

  it("leaves no unqualified record behind after a refresh", async () => {
    const context = await twoLocations()

    try {
      context.shared.set("nested/manifest/version", 5)
      context.shared.set(`nested/manifest/${context.scope}`, { directory: context.realA })
      context.shared.set("nested/commands/version", 1000)

      await context.outer.refresh()

      for (const prefix of LEGACY_STORAGE_PREFIXES) {
        expect([...context.shared.keys()].filter((key) => key.startsWith(prefix))).toEqual([])
      }
      expect(context.shared.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
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

const commandEntry = (name: string, directory: string): CommandEntry => ({
  name,
  canonicalPath: `${directory}/.opencode/command/${name}.md`,
  description: `${name} command`,
  template: `# ${name}\n`,
})

const commandSnapshotOf = (
  scope: string,
  directory: string,
  names: readonly string[],
): CommandSnapshot => ({
  scopeToken: scope,
  directory,
  commands: names.map((name) => commandEntry(name, directory)),
})

describe("command keys across two locations", () => {
  it("keeps one command record per location for the directory they share", async () => {
    const context = await twoLocations()

    try {
      await persistCommands(context.outerStore, {
        location: context.realRoot,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy"])],
        now: 1000,
      })
      await persistCommands(context.innerStore, {
        location: context.realA,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy", "release"])],
        now: 2000,
      })

      const outerManifestKey = commandKey(context.realRoot, `manifest/${context.scope}`)
      const innerManifestKey = commandKey(context.realA, `manifest/${context.scope}`)
      const outerManifest = context.shared.get(outerManifestKey) as unknown as {
        manifestVersion: number
        scopeToken: string
        directory: string
        entries: readonly unknown[]
      }
      const innerManifest = context.shared.get(innerManifestKey) as unknown as typeof outerManifest

      expect(context.shared.has(outerManifestKey)).toBe(true)
      expect(context.shared.has(innerManifestKey)).toBe(true)
      expect(outerManifest.entries).toHaveLength(1)
      expect(innerManifest.entries).toHaveLength(2)
      expect(outerManifest.scopeToken).toBe(context.scope)
      expect(innerManifest.scopeToken).toBe(context.scope)
      expect(outerManifest.directory).toBe(context.realA)
      expect(innerManifest.directory).toBe(context.realA)
      expect(outerManifest.manifestVersion).toBe(context.shared.get(commandKey(context.realRoot, "version")))
      expect(innerManifest.manifestVersion).toBe(context.shared.get(commandKey(context.realA, "version")))

      expect(context.shared.has(commandKey(context.realRoot, context.scope))).toBe(true)
      expect(context.shared.has(commandKey(context.realA, context.scope))).toBe(true)
      expect(context.shared.has(`nested/commands/manifest/${context.scope}`)).toBe(false)
    } finally {
      await context.cleanup()
    }
  })

  it("moves only its own command counter", async () => {
    const context = await twoLocations()

    try {
      await persistCommands(context.outerStore, {
        location: context.realRoot,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy"])],
        now: 1000,
      })
      await persistCommands(context.innerStore, {
        location: context.realA,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy", "release"])],
        now: 2000,
      })
      const outerVersion = context.shared.get(commandKey(context.realRoot, "version"))
      const innerVersion = context.shared.get(commandKey(context.realA, "version"))

      await persistCommands(context.innerStore, {
        location: context.realA,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy", "release", "tidy"])],
        now: 3000,
      })

      expect(context.shared.get(commandKey(context.realRoot, "version"))).toBe(outerVersion)
      expect(context.shared.get(commandKey(context.realA, "version"))).toBeGreaterThan(Number(innerVersion))

      const republished = await persistCommands(context.outerStore, {
        location: context.realRoot,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy"])],
        now: 4000,
      })

      expect(republished.written).toBe(false)
      expect(context.shared.get(commandKey(context.realRoot, "version"))).toBe(outerVersion)
    } finally {
      await context.cleanup()
    }
  })

  it("compares the stored signature of its own location only", async () => {
    const context = await twoLocations()
    const publish = (now: number) =>
      persistCommands(context.outerStore, {
        location: context.realRoot,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy"])],
        now,
      })

    try {
      const first = await publish(1000)
      expect(first.written).toBe(true)

      const afterFirst = new Map(context.shared)
      const again = await publish(2000)
      expect(again.written).toBe(false)
      expect(context.shared).toEqual(afterFirst)

      context.shared.set(commandKey(context.realA, context.scope), {
        manifestVersion: 1,
        scopeToken: context.scope,
        directory: context.realA,
        commands: [{ name: "release", canonicalPath: `${context.realA}/release.md`, template: "# release\n" }],
      })
      const withForeign = await publish(3000)
      expect(withForeign.written).toBe(false)

      context.shared.delete(commandKey(context.realRoot, context.scope))
      const rewritten = await publish(4000)

      expect(rewritten.written).toBe(true)
      expect(rewritten.version).toBeGreaterThan(first.version)
      expect(context.shared.get(commandKey(context.realRoot, "version"))).toBe(rewritten.version)
      expect(
        (context.shared.get(commandKey(context.realRoot, context.scope)) as unknown as { manifestVersion: number })
          .manifestVersion,
      ).toBe(rewritten.version)
    } finally {
      await context.cleanup()
    }
  })

  it("prunes its own command tokens and never the other location's record", async () => {
    const context = await twoLocations()

    try {
      await persistCommands(context.outerStore, {
        location: context.realRoot,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy"])],
        now: 1000,
      })
      await persistCommands(context.innerStore, {
        location: context.realA,
        snapshots: [commandSnapshotOf(context.scope, context.realA, ["deploy"])],
        now: 2000,
      })

      const outerManifestKey = commandKey(context.realRoot, `manifest/${context.scope}`)
      const outerSnapshotKey = commandKey(context.realRoot, context.scope)
      expect(context.shared.has(outerManifestKey)).toBe(true)
      expect(context.shared.has(outerSnapshotKey)).toBe(true)
      expect(context.shared.has(commandKey(context.realA, `manifest/${context.scope}`))).toBe(true)
      const before = structuredClone(context.shared.get(outerManifestKey))
      const cached = structuredClone(context.shared.get(outerSnapshotKey))

      const cleared = await persistCommands(context.innerStore, {
        location: context.realA,
        snapshots: [],
        now: 3000,
      })

      expect(cleared.ok).toBe(true)
      expect(context.shared.has(commandKey(context.realA, `manifest/${context.scope}`))).toBe(false)
      expect(context.shared.has(commandKey(context.realA, context.scope))).toBe(false)
      expect(context.shared.get(outerManifestKey)).toEqual(before)
      expect(context.shared.get(outerSnapshotKey)).toEqual(cached)
    } finally {
      await context.cleanup()
    }
  })
})
