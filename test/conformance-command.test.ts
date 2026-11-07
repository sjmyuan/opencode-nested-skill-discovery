import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRegistry, type Registry } from "../src/registry.ts"
import { commandDoc, writeCommand, writeCommandDoc } from "./support/command-family-fixtures.ts"
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
