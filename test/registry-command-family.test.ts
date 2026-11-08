import { realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { locationTokenFor, scopeTokenFor } from "../src/indexer.ts"
import { createRegistry } from "../src/registry.ts"
import { writeCommand } from "./support/command-family-fixtures.ts"
import { fakeContext } from "./support/fake-context.ts"
import { checkoutSkill, createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

const scanControl = vi.hoisted(() => ({ scans: 0 }))

vi.mock("../src/scan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scan.ts")>()
  return {
    ...actual,
    scanSkills: async (options: Parameters<typeof actual.scanSkills>[0]) => {
      scanControl.scans += 1
      return actual.scanSkills(options)
    },
  }
})

const workspaces: FamilyWorkspace[] = []

const workspace = async (): Promise<FamilyWorkspace> => {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

beforeEach(() => {
  scanControl.scans = 0
})

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const absolute = (ws: FamilyWorkspace, relativePath: string): string => path.join(ws.root, relativePath)

const familyLines = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("family:"))

const commandFamilyLines = (diagnostics: readonly string[]): readonly string[] =>
  familyLines(diagnostics).filter((line) => line.includes("/command/") || line.includes("/commands/"))

/** Main + linked worktree, each with the same root skill and root command (`deploy`). */
const buildWorkspace = async (): Promise<FamilyWorkspace> => {
  const ws = await workspace()
  await ws.repo("main")
  await ws.worktree("wt", "main", "linked")
  for (const checkout of ["main", "wt"]) {
    await checkoutSkill(ws, checkout, "deploy")
    await writeCommand(ws, checkout, "command", "deploy.md")
  }
  return ws
}

describe("the refresh runs the command family filter once per pass", () => {
  it("R1: one refresh scans once and reloads once while suppressing worktree commands", async () => {
    const ws = await buildWorkspace()
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))
    const fake = fakeContext([], { directory: ws.root })
    const registry = createRegistry(fake.ctx)

    try {
      const outcome = await registry.activate()

      expect(scanControl.scans).toBe(1)
      expect(outcome.ok).toBe(true)
      expect(outcome.reloads).toBe(1)
      expect(fake.reloadCalls).toBe(1)
      expect(outcome.diagnostics).toContain(
        `family: suppressed .opencode/command/deploy.md from ${wtReal} (survivor ${mainReal} has it)`,
      )
    } finally {
      await registry.dispose()
    }
  })

  it("R2: a suppressed worktree command adds no snapshot entry and keeps the survivor name", async () => {
    const ws = await buildWorkspace()
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))
    const locationToken = locationTokenFor(await realpath(ws.root))
    const fake = fakeContext([], { directory: ws.root })
    const registry = createRegistry(fake.ctx)

    try {
      const outcome = await registry.activate()

      const entries = fake.editor.list()
      expect(outcome.skills).toBe(1)
      expect(entries.map((entry) => String(entry.name))).toEqual(["main/deploy"])
      expect(entries.every((entry) => String(entry.path).startsWith(`${mainReal}/`))).toBe(true)
      expect(JSON.stringify([...fake.storage.values()])).not.toContain(wtReal)
      expect(fake.storage.has(`nested/${locationToken}/manifest/${scopeTokenFor(wtReal)}`)).toBe(false)
      expect(fake.storage.has(`nested/${locationToken}/subproject/${scopeTokenFor(wtReal)}`)).toBe(false)
    } finally {
      await registry.dispose()
    }
  })

  it("R3: a second refresh repeats the same single suppression line", async () => {
    const ws = await buildWorkspace()
    const fake = fakeContext([], { directory: ws.root })
    const registry = createRegistry(fake.ctx)

    try {
      const first = await registry.activate()
      const second = await registry.refresh()

      expect(scanControl.scans).toBe(2)
      expect(commandFamilyLines(first.diagnostics)).toHaveLength(1)
      expect(commandFamilyLines(second.diagnostics)).toEqual(commandFamilyLines(first.diagnostics))
      expect(commandFamilyLines([...first.diagnostics, ...second.diagnostics])).toHaveLength(2)
    } finally {
      await registry.dispose()
    }
  })
})
