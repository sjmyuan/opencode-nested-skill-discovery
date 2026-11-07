import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { scopeTokenFor } from "../src/indexer.ts"
import { createRegistry, type Registry } from "../src/registry.ts"
import { commandDoc, writeCommand, writeCommandDoc } from "./support/command-family-fixtures.ts"
import { commandStorage } from "./support/command-publish-fixtures.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

const workspaces: FamilyWorkspace[] = []
const homes: string[] = []

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nested-command-conformance-home-"))
  homes.push(home)
  vi.stubEnv("OPENCODE_TEST_HOME", home)
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(home, ".config", "opencode"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

afterAll(async () => {
  await Promise.all(workspaces.map((workspace) => workspace.cleanup()))
})

const workspace = async (): Promise<FamilyWorkspace> => {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

/**
 * PD2: a location above both checkouts. `main` is the repo, `wt` its linked worktree, and
 * `main/packages/app` a nested subproject. The root's own `.opencode/command` is claimed
 * and not scanned (`src/scan.ts:204-212`), so `main:deploy.md` there is native-only.
 */
const buildLocation = async (): Promise<FamilyWorkspace> => {
  const ws = await workspace()
  await ws.repo("main")
  await ws.worktree("wt", "main", "linked")
  await writeCommandDoc(ws, "", "command", "main:deploy.md", commandDoc("main:deploy"))
  await writeCommand(ws, "main", "command", "release.md")
  await writeCommand(ws, "main", "command", "deploy.md")
  await writeCommand(ws, "main/packages/app", "command", "tidy.md")
  await writeCommand(ws, "wt", "command", "release.md")
  await writeCommand(ws, "wt", "command", "wtonly.md")
  await writeCommand(ws, "wt/packages/app", "command", "tidy.md")
  return ws
}

const open = (ws: FamilyWorkspace): { readonly fake: FakeContext; readonly registry: Registry } => {
  const fake = fakeContext([], { directory: ws.root })
  return { fake, registry: createRegistry(fake.ctx) }
}

const namesOf = (entries: ReadonlyArray<{ readonly name: unknown }>): string[] =>
  entries.map((entry) => String(entry.name))

describe("conformance: the published command set", () => {
  it("CC1: a qualified, family-suppressed, native-shadowed set is published and listed", async () => {
    const ws = await buildLocation()
    const { fake, registry } = open(ws)

    try {
      const outcome = await registry.activate()
      const published = namesOf(fake.commandDefinitions).sort()
      const listed = namesOf((await fake.ctx.command.list()).data).sort()

      expect(published).toEqual(["main:packages:app:tidy", "main:release"])
      expect(listed).toEqual(published)
      expect(published.every((name) => name.includes(":"))).toBe(true)
      expect(outcome.diagnostics.filter((line) => line === "native-shadow: main:deploy")).toHaveLength(1)
      expect(outcome.commands).toBe(2)
      expect(outcome.reloads).toBe(1)
      expect(outcome.commandReloads).toBe(1)
    } finally {
      await registry.dispose()
    }
  })
})

describe("conformance: family suppression across a worktree and a nested subproject", () => {
  it("CC2: a non-survivor checkout publishes nothing, the flip restores it, and restoring .git suppresses it again", async () => {
    const ws = await buildLocation()
    const wtReal = await realpath(path.join(ws.root, "wt"))
    const { fake, registry } = open(ws)

    try {
      const first = await registry.activate()
      const suppressed = first.diagnostics.filter((line) => line.startsWith("family: suppressed"))

      expect(namesOf(fake.commandDefinitions).sort()).toEqual(["main:packages:app:tidy", "main:release"])
      expect(suppressed).toHaveLength(3)
      expect(suppressed.filter((line) => line.includes("(missing at survivor"))).toHaveLength(1)
      expect(fake.storage.has(`nested/commands/${scopeTokenFor(wtReal)}`)).toBe(false)
      expect(JSON.stringify(commandStorage(fake))).not.toContain(wtReal)
      expect(fake.commandReloadCalls).toBe(1)

      await rm(path.join(ws.root, "wt", ".git"))

      const flipped = await registry.refresh()

      expect(namesOf(fake.commandDefinitions).sort()).toEqual([
        "main:packages:app:tidy",
        "main:release",
        "wt:packages:app:tidy",
        "wt:release",
        "wt:wtonly",
      ])
      expect(flipped.diagnostics.filter((line) => line.startsWith("family:"))).toEqual([])
      expect(flipped.reloads).toBe(1)
      expect(fake.commandReloadCalls).toBe(2)

      await ws.worktree("wt", "main", "linked")

      const restored = await registry.refresh()

      expect(namesOf(fake.commandDefinitions).sort()).toEqual(["main:packages:app:tidy", "main:release"])
      expect(restored.diagnostics.filter((line) => line.startsWith("family: suppressed"))).toHaveLength(3)
      expect(fake.commandReloadCalls).toBe(3)
    } finally {
      await registry.dispose()
    }
  })
})

describe("conformance: native precedence, removal and a quiet rescan", () => {
  it("CC3: the pre-drop shadow is reported once, a late native entry is audited, and the next pass drops it", async () => {
    const ws = await buildLocation()
    const { fake, registry } = open(ws)

    try {
      const first = await registry.activate()

      expect(namesOf(fake.commandDefinitions).sort()).toEqual(["main:packages:app:tidy", "main:release"])
      expect(first.diagnostics.filter((line) => line === "native-shadow: main:deploy")).toHaveLength(1)
      expect(first.commands).toBe(2)

      fake.setNativeCommands([{ name: "main:release", description: "native release" }])

      const audited = await registry.refresh()

      expect(audited.commands).toBe(2)
      expect(audited.diagnostics.filter((line) => line === "native-shadow: main:release")).toHaveLength(0)
      expect(audited.diagnostics.filter((line) => line === "native-shadow: main:deploy")).toHaveLength(0)
      expect(audited.diagnostics.filter((line) => line === "native-shadow-audit: main:release")).toHaveLength(1)
      expect(JSON.stringify(commandStorage(fake))).toContain("main:release")

      const denied = await registry.refresh()

      expect(denied.commands).toBe(1)
      expect(JSON.stringify(commandStorage(fake))).not.toContain("main:release")
      expect(fake.commandDefinitions.filter((entry) => entry.name === "main:release")).toEqual([
        expect.objectContaining({ description: "native release" }),
      ])
      expect(denied.diagnostics.filter((line) => line === "native-shadow-audit: main:release")).toHaveLength(0)
    } finally {
      await registry.dispose()
    }
  })

  it("CC4: a deleted command leaves the listing and the cache, invokes nothing, and a quiet rescan writes nothing", async () => {
    const ws = await buildLocation()
    const { fake, registry } = open(ws)

    try {
      await registry.activate()
      await rm(path.join(ws.root, "main/packages/app/.opencode/command/tidy.md"))

      const removed = await registry.refresh()

      expect(removed.commands).toBe(1)
      expect(namesOf(fake.commandDefinitions)).toEqual(["main:release"])
      expect(JSON.stringify(commandStorage(fake))).not.toContain("main:packages:app:tidy")

      await fake.invokeCommand("main:packages:app:tidy", {
        sessionID: "parent",
        prompt: { text: "app" },
        delivery: "steer",
      })
      expect(fake.prompts).toEqual([])

      const before = JSON.stringify(commandStorage(fake))
      const quiet = await registry.refresh()

      expect(JSON.stringify(commandStorage(fake))).toBe(before)
      expect(quiet.diagnostics.filter((line) => line.startsWith("command-"))).toEqual([])
      expect(quiet.reloads).toBe(1)
    } finally {
      await registry.dispose()
    }
  })
})
