import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  STORAGE_KEYS,
  type CommandEntry,
  type CommandSnapshot,
} from "../src/contracts.ts"
import { persistCommands, type StoragePort } from "../src/manifest.ts"
import { fakeContext } from "./support/fake-context.ts"

const LOCATION = "/loc/root"

const entry = (name: string, overrides: Partial<CommandEntry> = {}): CommandEntry => ({
  name,
  canonicalPath: `${LOCATION}/A/.opencode/command/${name}.md`,
  description: `${name} command`,
  template: `# ${name}\n`,
  ...overrides,
})

const snapshotOf = (
  scopeToken: string,
  directory: string,
  commands: readonly CommandEntry[] = [entry(scopeToken)],
): CommandSnapshot => ({ scopeToken, directory, commands })

function seeded(seed?: Schema.Json) {
  return fakeContext(
    [],
    seed === undefined ? {} : { storage: [[STORAGE_KEYS.commandVersion, seed]] },
  )
}

function recording(storage: StoragePort): { readonly port: StoragePort; readonly writes: string[] } {
  const writes: string[] = []
  return {
    port: {
      ...storage,
      set: async (key, value) => {
        writes.push(key)
        await storage.set(key, value)
      },
    },
    writes,
  }
}

const isSkillKey = (key: string): boolean =>
  key.startsWith("nested/manifest/") || key.startsWith("nested/subproject/")

describe("command persistence", () => {
  it("M1: writes the counter, the manifest and the cache under the command keys", async () => {
    const fake = seeded()

    const result = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    const manifest = fake.storage.get(STORAGE_KEYS.commandManifest("token-a")) as unknown as {
      manifestVersion: number
      entries: readonly Record<string, unknown>[]
    }
    const cached = fake.storage.get(STORAGE_KEYS.commandSnapshot("token-a")) as unknown as {
      commands: readonly CommandEntry[]
    }

    expect(result).toEqual({ ok: true, version: 1000, written: true, pruned: 0, diagnostics: [] })
    expect(fake.storage.get(STORAGE_KEYS.commandVersion)).toBe(1000)
    expect(manifest.manifestVersion).toBe(1000)
    expect("template" in (manifest.entries[0] ?? {})).toBe(false)
    expect(cached.commands[0]?.template).toBe("# token-a\n")
  })

  it("M2: a second identical persist writes nothing and keeps the counter", async () => {
    const fake = seeded()
    const { port, writes } = recording(fake.ctx.storage)
    const input = { location: LOCATION, snapshots: [snapshotOf("token-a", `${LOCATION}/A`)], now: 1000 }

    const first = await persistCommands(port, input)
    writes.length = 0
    const second = await persistCommands(port, input)

    expect(first.written).toBe(true)
    expect(second).toEqual({ ok: true, version: 1000, written: false, pruned: 0, diagnostics: [] })
    expect(writes).toEqual([])
  })

  it("M3: a changed set bumps the counter once", async () => {
    const fake = seeded()
    const first = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })
    const second = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`, [entry("a"), entry("b")])],
      now: 1000,
    })

    expect(first.version).toBe(1000)
    expect(second).toMatchObject({ ok: true, version: 1001, written: true })
    expect(fake.storage.get(STORAGE_KEYS.commandVersion)).toBe(1001)
  })

  it("M4: prunes a stale in-location token from both prefixes and keeps the counter", async () => {
    const fake = seeded(1000)
    fake.storage.set(STORAGE_KEYS.commandManifest("token-old"), {
      manifestVersion: 1000,
      scopeToken: "token-old",
      directory: `${LOCATION}/Old`,
      entries: [],
    })
    fake.storage.set(STORAGE_KEYS.commandSnapshot("token-old"), {
      manifestVersion: 1000,
      scopeToken: "token-old",
      directory: `${LOCATION}/Old`,
      commands: [],
    })

    const result = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.pruned).toBe(2)
    expect(fake.storage.has(STORAGE_KEYS.commandManifest("token-old"))).toBe(false)
    expect(fake.storage.has(STORAGE_KEYS.commandSnapshot("token-old"))).toBe(false)
    expect(fake.storage.get(STORAGE_KEYS.commandVersion)).toBe(1001)
  })

  it("M5: pruning the snapshot prefix never removes an active manifest", async () => {
    const fake = seeded()

    await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })
    const before = fake.storage.get(STORAGE_KEYS.commandManifest("token-a"))
    const result = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.pruned).toBe(0)
    expect(fake.storage.get(STORAGE_KEYS.commandManifest("token-a"))).toEqual(before)
    expect(fake.storage.has(STORAGE_KEYS.commandSnapshot("token-a"))).toBe(true)
  })

  it("M6: keeps a record whose directory is outside the location", async () => {
    const fake = seeded()
    fake.storage.set(STORAGE_KEYS.commandManifest("token-other"), {
      manifestVersion: 1,
      scopeToken: "token-other",
      directory: "/elsewhere/project",
      entries: [],
    })
    fake.storage.set(STORAGE_KEYS.commandSnapshot("token-other"), {
      manifestVersion: 1,
      scopeToken: "token-other",
      directory: "/elsewhere/project",
      commands: [],
    })

    const result = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result.pruned).toBe(0)
    expect(fake.storage.has(STORAGE_KEYS.commandManifest("token-other"))).toBe(true)
    expect(fake.storage.has(STORAGE_KEYS.commandSnapshot("token-other"))).toBe(true)
  })

  it("M7: a failed write returns ok:false with one diagnostic and leaves the previous counter", async () => {
    const fake = seeded(1000)
    const port: StoragePort = {
      ...fake.ctx.storage,
      set: async (key, value) => {
        if (key === STORAGE_KEYS.commandVersion) throw new Error("storage down")
        await fake.ctx.storage.set(key, value)
      },
    }

    const result = await persistCommands(port, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(result).toEqual({
      ok: false,
      version: 1000,
      written: false,
      pruned: 0,
      diagnostics: ["version: storage down"],
    })
    expect(fake.storage.get(STORAGE_KEYS.commandVersion)).toBe(1000)
    expect(fake.storage.has(STORAGE_KEYS.commandManifest("token-a"))).toBe(false)
  })

  it("M8: no skill key is written", async () => {
    const fake = seeded()
    const { port, writes } = recording(fake.ctx.storage)

    await persistCommands(port, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })

    expect(writes.length).toBeGreaterThan(0)
    expect(writes.filter(isSkillKey)).toEqual([])
    expect(writes).not.toContain(STORAGE_KEYS.version)
  })

  it("M9: an empty snapshot set removes a previously written token", async () => {
    const fake = seeded()

    const first = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [snapshotOf("token-a", `${LOCATION}/A`)],
      now: 1000,
    })
    const second = await persistCommands(fake.ctx.storage, {
      location: LOCATION,
      snapshots: [],
      now: 1000,
    })

    expect(first.version).toBe(1000)
    expect(second).toMatchObject({ ok: true, version: 1001, written: true, pruned: 2 })
    expect(fake.storage.has(STORAGE_KEYS.commandManifest("token-a"))).toBe(false)
    expect(fake.storage.has(STORAGE_KEYS.commandSnapshot("token-a"))).toBe(false)
    expect(fake.storage.get(STORAGE_KEYS.commandVersion)).toBe(1001)
  })
})
