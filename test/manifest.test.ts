import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { STORAGE_KEYS, type ManifestRecord, type Snapshot } from "../src/contracts.ts"
import { locationTokenFor } from "../src/indexer.ts"
import { persistRegistry, type StoragePort } from "../src/manifest.ts"
import { fakeContext } from "./support/fake-context.ts"
import { registryEntry } from "./support/registry-fixtures.ts"

const LOCATION = "/loc/root"
const TOKEN = locationTokenFor(LOCATION)

const snapshotOf = (
  scopeToken: string,
  directory: string,
  skills: Snapshot["skills"] = [],
): Snapshot => ({ scopeToken, directory, skills })

function seeded(seed?: Schema.Json) {
  return fakeContext([], seed === undefined ? {} : { storage: [[STORAGE_KEYS.version(TOKEN), seed]] })
}

function forcedLimit(storage: StoragePort, limit: number): StoragePort {
  return {
    ...storage,
    scan: (options) => storage.scan({ ...options, limit }),
  }
}

describe("registry persistence", () => {
  it("writes the version, a content-free manifest, and a snapshot cache", async () => {
    const fake = seeded()
    const skill = registryEntry({ id: "nested.s.1", subproject: "A" })

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`, [skill])],
      now: 1000,
    })

    const manifest = fake.storage.get(STORAGE_KEYS.manifest(TOKEN, "token-a")) as unknown as ManifestRecord
    const cached = fake.storage.get(STORAGE_KEYS.subproject(TOKEN, "token-a")) as unknown as Snapshot
    const manifestEntry = manifest.entries[0]

    expect(result).toEqual({ ok: true, version: 1000, pruned: 0, diagnostics: [] })
    expect(fake.storage.get(STORAGE_KEYS.version(TOKEN))).toBe(1000)
    expect(manifest).toMatchObject({
      manifestVersion: 1000,
      scopeToken: "token-a",
      directory: `${LOCATION}/A`,
    })
    expect(manifestEntry?.id).toBe("nested.s.1")
    expect(manifestEntry === undefined ? true : "content" in manifestEntry).toBe(false)
    expect(manifestEntry === undefined ? true : "subproject" in manifestEntry).toBe(false)
    expect(cached.skills[0]?.content).toBe(skill.content)
    expect(cached.skills[0] === undefined ? true : "subproject" in cached.skills[0]).toBe(false)
  })

  it("stamps every record of one refresh with the same counter", async () => {
    const fake = seeded()

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [
        snapshotOf("token-b", `${LOCATION}/B`, [registryEntry({ id: "nested.b.1" })]),
        snapshotOf("token-a", `${LOCATION}/A`, [registryEntry({ id: "nested.a.1" })]),
      ],
      now: 1000,
    })

    const versions = ["token-a", "token-b"].map(
      (token) => (fake.storage.get(STORAGE_KEYS.manifest(TOKEN, token)) as unknown as ManifestRecord).manifestVersion,
    )

    expect(result.version).toBe(1000)
    expect(versions).toEqual([1000, 1000])
  })

  it("increases the counter on every refresh", async () => {
    const fake = seeded()
    const input = { location: LOCATION, snapshots: [snapshotOf("token-a", LOCATION)] }

    const first = await persistRegistry(fake.ctx.storage, { ...input, now: 1000 })
    const second = await persistRegistry(fake.ctx.storage, { ...input, now: 1000 })

    expect(first.version).toBe(1000)
    expect(second.version).toBe(1001)
    expect(fake.storage.get(STORAGE_KEYS.version(TOKEN))).toBe(1001)
  })

  it.each([
    { row: "absent", seed: undefined, now: 1000, expected: 1000 },
    { row: "ahead of the clock", seed: 1005, now: 1000, expected: 1006 },
    { row: "clock ahead", seed: 1000, now: 1005, expected: 1005 },
    { row: "tie", seed: 1000, now: 1000, expected: 1001 },
    { row: "numeric string", seed: "7", now: 1000, expected: 1000 },
    { row: "fraction", seed: 7.5, now: 1000, expected: 1000 },
    { row: "negative", seed: -3, now: 1000, expected: 1000 },
    { row: "null", seed: null, now: 1000, expected: 1000 },
    { row: "object", seed: { counter: 7 }, now: 1000, expected: 1000 },
  ])("bumps the counter for a $row current value", async ({ seed, now, expected }) => {
    const fake = seeded(seed as Schema.Json | undefined)

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", LOCATION)],
      now,
    })

    expect(result.version).toBe(expected)
    expect(fake.storage.get(STORAGE_KEYS.version(TOKEN))).toBe(expected)
  })

  it("prunes inactive records of this location from both prefixes", async () => {
    const fake = seeded()
    const stale = { directory: `${LOCATION}/Old`, manifestVersion: 1, scopeToken: "token-old" }
    fake.storage.set(STORAGE_KEYS.manifest(TOKEN, "token-old"), stale)
    fake.storage.set(STORAGE_KEYS.subproject(TOKEN, "token-old"), { directory: `${LOCATION}/Old` })

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.pruned).toBe(2)
    expect(fake.storage.has(STORAGE_KEYS.manifest(TOKEN, "token-old"))).toBe(false)
    expect(fake.storage.has(STORAGE_KEYS.subproject(TOKEN, "token-old"))).toBe(false)
    expect(fake.storage.has(STORAGE_KEYS.manifest(TOKEN, "token-a"))).toBe(true)
    expect(fake.storage.has(STORAGE_KEYS.subproject(TOKEN, "token-a"))).toBe(true)
  })

  it("keeps records that belong to another location", async () => {
    const fake = seeded()
    fake.storage.set(STORAGE_KEYS.manifest(TOKEN, "token-other"), {
      manifestVersion: 1,
      scopeToken: "token-other",
      directory: "/elsewhere/project",
      entries: [],
    })
    fake.storage.set(STORAGE_KEYS.subproject(TOKEN, "token-other"), { directory: "/elsewhere/project" })

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [],
      now: 1000,
    })

    expect(result.pruned).toBe(0)
    expect(fake.storage.has(STORAGE_KEYS.manifest(TOKEN, "token-other"))).toBe(true)
    expect(fake.storage.has(STORAGE_KEYS.subproject(TOKEN, "token-other"))).toBe(true)
  })

  it("keeps the version counter and unparsable values", async () => {
    const fake = seeded(42)
    fake.storage.set(STORAGE_KEYS.manifest(TOKEN, "token-broken"), "not a record")

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [],
      now: 1000,
    })

    expect(result).toEqual({ ok: true, version: 1000, pruned: 0, diagnostics: [] })
    expect(fake.storage.get(STORAGE_KEYS.version(TOKEN))).toBe(1000)
    expect(fake.storage.get(STORAGE_KEYS.manifest(TOKEN, "token-broken"))).toBe("not a record")
  })

  it("prunes every stale page when the store returns bounded pages", async () => {
    const fake = seeded()
    for (let index = 0; index < 5; index += 1) {
      fake.storage.set(STORAGE_KEYS.manifest(TOKEN, `token-${index}`), { directory: `${LOCATION}/${index}` })
      fake.storage.set(STORAGE_KEYS.subproject(TOKEN, `token-${index}`), { directory: `${LOCATION}/${index}` })
    }

    const result = await persistRegistry(forcedLimit(fake.ctx.storage, 2), {
      location: LOCATION,
      snapshots: [snapshotOf("token-live", `${LOCATION}/live`)],
      now: 1000,
    })

    expect(result.pruned).toBe(10)
    for (let index = 0; index < 5; index += 1) {
      expect(fake.storage.has(STORAGE_KEYS.manifest(TOKEN, `token-${index}`))).toBe(false)
      expect(fake.storage.has(STORAGE_KEYS.subproject(TOKEN, `token-${index}`))).toBe(false)
    }
    expect(fake.storage.has(STORAGE_KEYS.manifest(TOKEN, "token-live"))).toBe(true)
  })

  it("keeps the records and reports a prune failure", async () => {
    const fake = seeded()
    fake.storage.set(STORAGE_KEYS.manifest(TOKEN, "token-old"), { directory: `${LOCATION}/Old` })
    fake.fail("storage.scan", new Error("scan down"))

    const result = await persistRegistry(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.pruned).toBe(0)
    expect(result.diagnostics).toEqual(["prune: scan down"])
    expect(fake.storage.has(STORAGE_KEYS.manifest(TOKEN, "token-a"))).toBe(true)
    expect(fake.storage.has(STORAGE_KEYS.subproject(TOKEN, "token-a"))).toBe(true)
    expect(fake.storage.has(STORAGE_KEYS.manifest(TOKEN, "token-old"))).toBe(true)
  })
})
