import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { STORAGE_FORMAT_KEY, STORAGE_KEYS, type ManifestRecord, type Snapshot } from "../src/contracts.ts"
import { locationTokenFor, scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import type { StoragePort } from "../src/manifest.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\ndescription: Deploys releases.\n---\n# Deploy\n"
const COMMAND = "---\ndescription: Deploy command\n---\nDeploy.\n"

const manifestOf = (store: Map<string, Schema.Json>, key: string): ManifestRecord =>
  store.get(key) as unknown as ManifestRecord

const cacheOf = (store: Map<string, Schema.Json>, key: string): Snapshot => store.get(key) as unknown as Snapshot

describe("stored records stay advisory", () => {
  it("rewrites a seeded record from disk instead of replaying it", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      const realRoot = fixture.realRoot
      const realA = await fixture.realpathOf("A")
      const skillPath = await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md")
      const token = locationTokenFor(realRoot)
      const scope = scopeTokenFor(realA)
      const survivor = `nested.${scope}.${skillTokenFor("deploy", skillPath)}`
      const fake = fakeContext([], {
        directory: realRoot,
        storage: [
          [
            STORAGE_KEYS.manifest(token, scope),
            {
              manifestVersion: 1,
              scopeToken: scope,
              directory: realA,
              entries: [{ id: "nested.bogus.x", canonicalPath: "/nowhere/bogus/SKILL.md", name: "bogus" }],
            },
          ],
          [
            STORAGE_KEYS.subproject(token, scope),
            {
              scopeToken: scope,
              directory: realA,
              skills: [
                {
                  id: "nested.bogus.x",
                  canonicalPath: "/nowhere/bogus/SKILL.md",
                  name: "bogus",
                  content: "# bogus\n",
                },
              ],
            },
          ],
        ],
      })
      const registry = createRegistry(fake.ctx)

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(true)
      expect(registry.snapshot.snapshots.flatMap((entry) => entry.skills.map((skill) => skill.id))).toEqual([
        survivor,
      ])
      expect(fake.editor.list().map((entry) => String(entry.id))).toEqual([survivor])
      expect(
        manifestOf(fake.storage, STORAGE_KEYS.manifest(token, scope)).entries.map((entry) => entry.id),
      ).toEqual([survivor])
      expect(cacheOf(fake.storage, STORAGE_KEYS.subproject(token, scope)).skills.map((entry) => entry.id)).toEqual([
        survivor,
      ])
      expect(JSON.stringify([...fake.storage.values()])).not.toContain("nested.bogus.x")
    } finally {
      await fixture.cleanup()
    }
  })

  it("reads only its own counters, the format marker and one command snapshot", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("A/.opencode/command/deploy.md", COMMAND)
      const realRoot = fixture.realRoot
      const token = locationTokenFor(realRoot)
      const fake = fakeContext([], { directory: realRoot })
      const target = fake.ctx.storage
      const operations: { kind: "get" | "set" | "remove" | "scan"; key: string }[] = []
      const port: StoragePort = {
        get: (key) => {
          operations.push({ kind: "get", key })
          return target.get(key)
        },
        set: async (key, value) => {
          operations.push({ kind: "set", key })
          await target.set(key, value)
        },
        remove: async (key) => {
          operations.push({ kind: "remove", key })
          await target.remove(key)
        },
        scan: (options) => {
          operations.push({ kind: "scan", key: options.prefix })
          return target.scan(options)
        },
      }
      fake.storage.set("nested/manifest/legacy-token", { directory: "/elsewhere" })
      ;(fake.ctx as unknown as { storage: StoragePort }).storage = port

      const outcome = await createRegistry(fake.ctx).refresh()

      expect(outcome.ok).toBe(true)
      expect(outcome.skills).toBe(1)

      const stored = [...fake.storage.keys()]
      const allowed = new Set([
        STORAGE_KEYS.version(token),
        STORAGE_FORMAT_KEY,
        STORAGE_KEYS.commandVersion(token),
        ...stored.filter((key) => key.startsWith(STORAGE_KEYS.commandSnapshot(token, ""))),
      ])
      const reads = operations.filter((operation) => operation.kind === "get").map((operation) => operation.key)

      expect(reads.length).toBeGreaterThan(0)
      expect(reads.filter((key) => !allowed.has(key))).toEqual([])
      expect(reads.filter((key) => key.startsWith(STORAGE_KEYS.manifest(token, "")))).toEqual([
        STORAGE_KEYS.version(token),
      ])
      expect(reads.filter((key) => key.startsWith(STORAGE_KEYS.subproject(token, "")))).toEqual([])
      expect(reads.filter((key) => key.startsWith(STORAGE_KEYS.commandSnapshot(token, ""))).length).toBeGreaterThan(0)

      for (const operation of operations) {
        if (operation.kind !== "scan") continue
        if (!operation.key.startsWith(`nested/${token}/`)) continue
        const firstSet = operations.findIndex(
          (candidate) => candidate.kind === "set" && candidate.key.startsWith(operation.key),
        )
        expect(firstSet).toBeGreaterThan(-1)
        expect(operations.indexOf(operation)).toBeGreaterThan(firstSet)
      }

      const lastSkillSet = operations.reduce(
        (last, operation, index) =>
          operation.kind === "set" &&
          (operation.key.startsWith(STORAGE_KEYS.manifest(token, "")) ||
            operation.key.startsWith(STORAGE_KEYS.subproject(token, "")))
            ? index
            : last,
        -1,
      )
      const legacyRemove = operations.findIndex((operation) => operation.kind === "remove")
      const markerSet = operations.findIndex(
        (operation) => operation.kind === "set" && operation.key === STORAGE_FORMAT_KEY,
      )
      const firstCommandWrite = operations.findIndex(
        (operation) => operation.kind !== "get" && operation.key.startsWith(`nested/${token}/commands/`),
      )

      expect(legacyRemove).toBeGreaterThan(lastSkillSet)
      expect(markerSet).toBeGreaterThan(legacyRemove)
      expect(firstCommandWrite).toBeGreaterThan(markerSet)
    } finally {
      await fixture.cleanup()
    }
  })
})
