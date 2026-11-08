import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  LEGACY_STORAGE_PREFIXES,
  STORAGE_FORMAT,
  STORAGE_FORMAT_KEY,
  STORAGE_KEYS,
  type CommandSnapshot,
  type Snapshot,
} from "../src/contracts.ts"
import { locationTokenFor } from "../src/indexer.ts"
import { persistCommands, persistRegistry, type StoragePort } from "../src/manifest.ts"
import { fakeContext } from "./support/fake-context.ts"
import { registryEntry } from "./support/registry-fixtures.ts"

const LOCATION = "/loc/root"
const TOKEN = locationTokenFor(LOCATION)
const ELSEWHERE = locationTokenFor("/somewhere/else")

type Entry = readonly [string, Schema.Json]

const snapshotOf = (scopeToken: string, directory: string, skills: Snapshot["skills"] = []): Snapshot => ({
  scopeToken,
  directory,
  skills,
})

const commandSnapshotOf = (scopeToken: string, directory: string): CommandSnapshot => ({
  scopeToken,
  directory,
  commands: [
    {
      name: "deploy",
      canonicalPath: `${directory}/.opencode/command/deploy.md`,
      description: "deploy command",
      template: "# deploy\n",
    },
  ],
})

const legacySkillKeys = (token = "token-a", directory = `${LOCATION}/A`): readonly Entry[] => [
  ["nested/manifest/version", 5],
  [`nested/manifest/${token}`, { manifestVersion: 1, scopeToken: token, directory, entries: [] }],
  [`nested/subproject/${token}`, { scopeToken: token, directory, skills: [] }],
]

const legacyCommandKeys = (token = "token-a", directory = `${LOCATION}/A`): readonly Entry[] => [
  ["nested/commands/version", 1000],
  [
    `nested/commands/manifest/${token}`,
    { manifestVersion: 1, scopeToken: token, directory, entries: [{ name: "deploy" }] },
  ],
  [
    `nested/commands/${token}`,
    { manifestVersion: 1, scopeToken: token, directory, commands: [{ name: "deploy", template: "# deploy\n" }] },
  ],
]

const fakeWith = (...entries: readonly Entry[]) => fakeContext([], { storage: entries })

const qualifiedManifest = (token: string) => STORAGE_KEYS.manifest(TOKEN, token)

describe("one-time legacy migration", () => {
  it("M1: removes the unqualified records after writing the new layout", async () => {
    const fake = fakeWith(...legacySkillKeys())

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`, [registryEntry({ id: "nested.s.1" })])],
      now: 1000,
    })

    expect(result).toEqual({ ok: true, version: 1000, pruned: 0, diagnostics: [] })
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(false)
    expect(fake.storage.has(qualifiedManifest("token-a"))).toBe(true)
    expect(fake.storage.has(STORAGE_KEYS.subproject(TOKEN, "token-a"))).toBe(true)
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
  })

  it("M2: sweeps exactly once, so a re-seeded legacy key survives", async () => {
    const fake = fakeWith(...legacySkillKeys())
    await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    fake.storage.set("nested/manifest/token-late", { manifestVersion: 1, scopeToken: "token-late", directory: "/x" })
    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1001,
    })

    expect(result.diagnostics).toEqual([])
    expect(fake.storage.has("nested/manifest/token-late")).toBe(true)
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
    expect(fake.storage.has(qualifiedManifest("token-a"))).toBe(true)
  })

  it("M3: leaves the legacy records and the marker alone when the new layout fails", async () => {
    const fake = fakeWith(...legacySkillKeys())
    fake.failKey(qualifiedManifest("token-a"), new Error("manifest down"))

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(["manifest: token-a: manifest down"])
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(true)
    expect(fake.storage.has(STORAGE_FORMAT_KEY)).toBe(false)
  })

  it("M4: reports a sweep failure, keeps the marker unwritten, and retries", async () => {
    const fake = fakeWith(...legacySkillKeys())
    fake.fail("storage.remove", new Error("remove down"))

    const failed = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(failed.ok).toBe(true)
    expect(failed.diagnostics).toEqual(["migrate: remove down"])
    expect(fake.storage.has(qualifiedManifest("token-a"))).toBe(true)
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(true)
    expect(fake.storage.has(STORAGE_FORMAT_KEY)).toBe(false)

    fake.clearFailures()
    const retried = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1001,
    })

    expect(retried.diagnostics).toEqual([])
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(false)
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
  })

  it("M5: reports a marker write failure once the sweep is done", async () => {
    const fake = fakeWith(...legacySkillKeys())
    const target = fake.ctx.storage
    const port: StoragePort = {
      get: (key) => target.get(key),
      set: async (key, value) => {
        if (key === STORAGE_FORMAT_KEY) throw new Error("marker down")
        await target.set(key, value)
      },
      remove: (key) => target.remove(key),
      scan: (options) => target.scan(options),
    }

    const result = await persistRegistry(port, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual(["migrate: marker down"])
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(false)
    expect(fake.storage.has(STORAGE_FORMAT_KEY)).toBe(false)
  })

  it("M6: does nothing once the marker is written", async () => {
    const fake = fakeWith([STORAGE_FORMAT_KEY, STORAGE_FORMAT], ...legacySkillKeys())

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.diagnostics).toEqual([])
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(true)
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
  })

  it("M7: sweeps more legacy keys than one page", async () => {
    const seeds: Entry[] = []
    for (let index = 0; index < 250; index += 1) {
      seeds.push([`nested/manifest/token-${String(index).padStart(3, "0")}`, { directory: "/elsewhere" }])
    }
    const fake = fakeWith(...seeds)

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [],
      now: 1000,
    })

    expect(result.diagnostics).toEqual([])
    expect([...fake.storage.keys()].filter((key) => key.startsWith("nested/manifest/"))).toEqual([])
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
  })

  it("M8: sweeps the three legacy command prefixes under the same marker", async () => {
    const fake = fakeWith(...legacyCommandKeys())

    await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [commandSnapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })
    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [],
      now: 1001,
    })

    expect(result.diagnostics).toEqual([])
    for (const [key] of legacyCommandKeys()) expect(fake.storage.has(key)).toBe(false)
    expect(fake.storage.get(STORAGE_KEYS.commandVersion(TOKEN))).toBe(1000)
    expect(fake.storage.has(STORAGE_KEYS.commandManifest(TOKEN, "token-a"))).toBe(true)
    expect(fake.storage.has(STORAGE_KEYS.commandSnapshot(TOKEN, "token-a"))).toBe(true)
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
    expect(LEGACY_STORAGE_PREFIXES).toHaveLength(5)
  })

  it("M9: leaves a qualified command record of another location untouched", async () => {
    const foreign = {
      manifestVersion: 1,
      scopeToken: "token-a",
      directory: `${LOCATION}/A`,
      commands: [{ name: "deploy", template: "# deploy\n" }],
    }
    const fake = fakeWith(
      ...legacyCommandKeys(),
      [STORAGE_KEYS.commandSnapshot(ELSEWHERE, "token-a"), foreign],
      [STORAGE_KEYS.commandManifest(ELSEWHERE, "token-a"), { ...foreign, entries: [] }],
    )

    await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [commandSnapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })
    await persistRegistry(fake.ctx.storage, { location: LOCATION, snapshots: [], now: 1001 })

    expect(fake.storage.get(STORAGE_KEYS.commandSnapshot(ELSEWHERE, "token-a"))).toEqual(foreign)
    expect(fake.storage.has(STORAGE_KEYS.commandSnapshot(TOKEN, "token-a"))).toBe(true)
  })

  it("M10: runs nothing when the skill layout fails", async () => {
    const fake = fakeWith(...legacySkillKeys(), ...legacyCommandKeys())
    fake.failKey(qualifiedManifest("token-a"), new Error("manifest down"))

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.ok).toBe(false)
    for (const [key] of legacyCommandKeys()) expect(fake.storage.has(key)).toBe(true)
    expect(fake.storage.has(STORAGE_FORMAT_KEY)).toBe(false)
  })

  it("M11: one marker covers both stores", async () => {
    const fake = fakeWith(...legacySkillKeys(), ...legacyCommandKeys())
    await persistRegistry(fake.ctx.storage, { location: LOCATION, snapshots: [], now: 1000 })

    fake.storage.set("nested/commands/manifest/token-late", { manifestVersion: 1, scopeToken: "token-late" })
    const result = await persistRegistry(fake.ctx.storage, { location: LOCATION, snapshots: [], now: 1001 })

    expect(result.diagnostics).toEqual([])
    expect(fake.storage.has("nested/commands/manifest/token-late")).toBe(true)
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(STORAGE_FORMAT)
    expect([...fake.storage.keys()].filter((key) => key.startsWith("nested/format"))).toEqual([STORAGE_FORMAT_KEY])
  })

  it("M13: reports an unreadable marker and sweeps nothing", async () => {
    const fake = fakeWith([STORAGE_FORMAT_KEY, 1], ...legacySkillKeys())
    const target = fake.ctx.storage
    const port: StoragePort = {
      get: async (key) => {
        if (key === STORAGE_FORMAT_KEY) throw new Error("marker down")
        return target.get(key)
      },
      set: (key, value) => target.set(key, value),
      remove: (key) => target.remove(key),
      scan: (options) => target.scan(options),
    }

    const result = await persistRegistry(port, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual(["migrate: marker down"])
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(true)
    expect(fake.storage.get(STORAGE_FORMAT_KEY)).toBe(1)
  })

  it("M14: reports a sweep scan failure without writing the marker", async () => {
    const fake = fakeWith(...legacySkillKeys())
    const target = fake.ctx.storage
    const port: StoragePort = {
      get: (key) => target.get(key),
      set: (key, value) => target.set(key, value),
      remove: (key) => target.remove(key),
      scan: async (options) => {
        if (LEGACY_STORAGE_PREFIXES.some((prefix) => options.prefix.startsWith(prefix))) {
          throw new Error("sweep scan down")
        }
        return target.scan(options)
      },
    }

    const result = await persistRegistry(port, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual(["migrate: sweep scan down"])
    for (const [key] of legacySkillKeys()) expect(fake.storage.has(key)).toBe(true)
    expect(fake.storage.has(STORAGE_FORMAT_KEY)).toBe(false)
    expect(fake.storage.has(qualifiedManifest("token-a"))).toBe(true)
  })

  it("M12: writes the new layout before it removes anything legacy", async () => {
    const fake = fakeWith(...legacySkillKeys(), ...legacyCommandKeys())
    const target = fake.ctx.storage
    const operations: { kind: "set" | "remove"; key: string }[] = []
    const port: StoragePort = {
      get: (key) => target.get(key),
      set: async (key, value) => {
        operations.push({ kind: "set", key })
        await target.set(key, value)
      },
      remove: async (key) => {
        operations.push({ kind: "remove", key })
        await target.remove(key)
      },
      scan: (options) => target.scan(options),
    }

    await persistRegistry(port, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`, [registryEntry({ id: "nested.s.1" })])],
      now: 1000,
    })

    const removes = operations.filter((operation) => operation.kind === "remove")
    expect(removes.length).toBe(6)
    expect(
      removes.every((operation) =>
        LEGACY_STORAGE_PREFIXES.some((prefix) => operation.key.startsWith(prefix)),
      ),
    ).toBe(true)
    expect(removes.every((operation) => !operation.key.includes(TOKEN))).toBe(true)

    const firstRemove = operations.findIndex((operation) => operation.kind === "remove")
    const qualifiedSets = operations.filter(
      (operation) => operation.kind === "set" && operation.key !== STORAGE_FORMAT_KEY,
    )
    expect(qualifiedSets.length).toBeGreaterThan(0)
    expect(qualifiedSets.every((operation) => operation.key.includes(TOKEN))).toBe(true)

    const lastQualified = qualifiedSets[qualifiedSets.length - 1]
    expect(lastQualified).toBeDefined()
    expect(operations.indexOf(lastQualified as { kind: "set"; key: string })).toBeLessThan(firstRemove)
  })
})
