import { realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { scopeTokenFor } from "../src/indexer.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { checkoutSkill, createFamilyWorkspace, nestedCheckoutSkill, type FamilyWorkspace } from "./support/family-fixtures.ts"

const NESTED = "packages/app/.claude/skills"
const COPILOT = "extensions/copilot/.claude/skills"

const workspaces: FamilyWorkspace[] = []

const workspace = async (): Promise<FamilyWorkspace> => {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const absolute = (ws: FamilyWorkspace, relativePath: string): string => path.join(ws.root, relativePath)

const namesOf = (entries: ReadonlyArray<{ readonly name: unknown }>): readonly string[] =>
  entries.map((entry) => String(entry.name))

const buildNestedWorkspace = async (): Promise<FamilyWorkspace> => {
  const ws = await workspace()
  await ws.repo("main")
  await ws.worktree("wt", "main", "linked")
  await checkoutSkill(ws, "main", "deploy")
  await nestedCheckoutSkill(ws, "main", NESTED, "tidy")
  await checkoutSkill(ws, "wt", "deploy")
  await nestedCheckoutSkill(ws, "wt", NESTED, "tidy")
  return ws
}

describe("conformance: nested subprojects share one checkout view", () => {
  it("C10: only the survivor's nested entries are advertised and stale worktree records are pruned", async () => {
    const ws = await buildNestedWorkspace()
    const wtReal = await realpath(absolute(ws, "wt"))
    const nestedReal = await realpath(absolute(ws, "wt/packages/app"))
    const wtToken = scopeTokenFor(wtReal)
    const nestedToken = scopeTokenFor(nestedReal)
    const fake = fakeContext([], {
      directory: ws.root,
      storage: [
        [`nested/manifest/${nestedToken}`, { manifestVersion: 1, scopeToken: nestedToken, directory: nestedReal, entries: [] }],
        [`nested/subproject/${nestedToken}`, { scopeToken: nestedToken, directory: nestedReal, skills: [] }],
      ],
    })
    const registry = createRegistry(fake.ctx)

    try {
      const outcome = await registry.activate()
      const names = namesOf(fake.editor.list())
      const directories = [...fake.storage.values()]
        .map((value) =>
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as { directory?: unknown }).directory
            : undefined,
        )
        .filter((value): value is string => typeof value === "string")

      expect(outcome.ok).toBe(true)
      expect(outcome.skills).toBe(2)
      expect(outcome.subprojects).toBe(2)
      expect(outcome.reloads).toBe(1)
      expect(fake.reloadCalls).toBe(1)
      expect([...names].sort()).toEqual(["main/deploy", "main/packages/app/tidy"])
      expect(new Set(names).size).toBe(names.length)
      expect(directories.filter((directory) => directory === wtReal || directory.startsWith(`${wtReal}/`))).toEqual([])
      expect(fake.storage.has(`nested/manifest/${wtToken}`)).toBe(false)
      expect(fake.storage.has(`nested/subproject/${wtToken}`)).toBe(false)
      expect(fake.storage.has(`nested/manifest/${nestedToken}`)).toBe(false)
      expect(fake.storage.has(`nested/subproject/${nestedToken}`)).toBe(false)
    } finally {
      await registry.dispose()
    }
  })

  it("C11: distinct subprojects of one repo stay advertised, and a worktree-located session keeps its nested view", async () => {
    const ws = await workspace()
    await ws.repo("vscode")
    await checkoutSkill(ws, "vscode", "launch")
    for (const slug of ["launch", "sample", "tidy"]) await nestedCheckoutSkill(ws, "vscode", COPILOT, slug)

    const local = await workspace()
    await local.repo("main")
    await local.worktree("wt", "main", "linked")
    await nestedCheckoutSkill(local, "wt", NESTED, "tidy")

    const atRoot = fakeContext([], { directory: ws.root })
    const rootRegistry = createRegistry(atRoot.ctx)
    const atWorktree = fakeContext([], { directory: await realpath(absolute(local, "wt")) })
    const worktreeRegistry = createRegistry(atWorktree.ctx)

    try {
      const root = await rootRegistry.activate()
      const names = namesOf(atRoot.editor.list())
      const ids = atRoot.editor.list().map((entry) => String(entry.id))

      expect(root.skills).toBe(4)
      expect([...names].sort()).toEqual(
        ["vscode/launch", "vscode/extensions/copilot/launch", "vscode/extensions/copilot/sample", "vscode/extensions/copilot/tidy"].sort(),
      )
      expect(new Set(ids).size).toBe(ids.length)
      expect(root.diagnostics.filter((line) => line.startsWith("family:"))).toEqual([])

      const scoped = await worktreeRegistry.activate()
      const localEntries = atWorktree.editor.list()

      expect(scoped.ok).toBe(true)
      expect(localEntries).toHaveLength(1)
      expect(namesOf(localEntries)).toEqual(["packages/app/tidy"])
      expect(scoped.diagnostics.filter((line) => line.startsWith("family:"))).toEqual([])
    } finally {
      await rootRegistry.dispose()
      await worktreeRegistry.dispose()
    }
  })
})
