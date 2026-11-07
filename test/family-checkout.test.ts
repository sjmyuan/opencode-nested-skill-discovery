import { chmod, realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { deriveFamilies } from "../src/family.ts"
import { createFamilyWorkspace, plainProject, type FamilyWorkspace } from "./support/family-fixtures.ts"

const trace = vi.hoisted(() => ({ recording: false, gitStats: 0, gitOpens: 0 }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()

  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (trace.recording && String(args[0]).endsWith("/.git")) trace.gitStats += 1
      return actual.lstat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (trace.recording && String(args[0]).endsWith("/.git")) trace.gitOpens += 1
      return actual.open(...args)
    },
  }
})

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

describe("checkout resolution for nested subprojects", () => {
  it("A16: a nested subproject without its own .git resolves to the enclosing checkout", async () => {
    const ws = await workspace()
    await ws.repo("main")
    const nested = await ws.mkdirp("main/packages/app")

    const derived = await deriveFamilies([nested], ws.root)

    expect(derived.diagnostics).toEqual([])
    expect(derived.families.get(nested)?.familyKey).toBe(await realpath(absolute(ws, "main/.git")))
    expect(derived.families.get(nested)?.survivor).toBe(await realpath(absolute(ws, "main")))
  })

  it("A17: a nested subproject in a linked worktree resolves to the worktree and the main survivor", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    const nested = await ws.mkdirp("wt/packages/app")

    const derived = await deriveFamilies([nested], ws.root)

    expect(derived.diagnostics).toEqual([])
    expect(derived.families.get(nested)?.familyKey).toBe(await realpath(absolute(ws, "main/.git")))
    expect(derived.families.get(nested)?.survivor).toBe(await realpath(absolute(ws, "main")))
  })

  it("A18: the nearest .git ancestor wins over a further one", async () => {
    const ws = await workspace()
    await ws.repo("repo")
    await ws.repo("repo/a")
    const nested = await ws.mkdirp("repo/a/b")

    const derived = await deriveFamilies([nested], ws.root)

    expect(derived.families.get(nested)?.familyKey).toBe(await realpath(absolute(ws, "repo/a/.git")))
    expect(derived.families.get(nested)?.survivor).toBe(await realpath(absolute(ws, "repo/a")))
  })

  it("A19: a .git at the location is ignored while one strictly inside is honoured", async () => {
    const ws = await workspace()
    await ws.repo("")
    await ws.repo("inside")
    const outside = await ws.mkdirp("pkg/inner")
    const inside = await ws.mkdirp("inside/inner")

    const derived = await deriveFamilies([outside, inside], ws.root)

    expect(derived.diagnostics).toEqual([])
    expect(derived.families.has(outside)).toBe(false)
    expect(derived.families.get(inside)?.survivor).toBe(await realpath(absolute(ws, "inside")))
  })

  it("A20: a nested subproject inside a submodule resolves to the submodule, never the parent repo", async () => {
    const ws = await workspace()
    await ws.repo("parent")
    const modules = await ws.mkdirp("parent/.git/modules/sub")
    await ws.write("sub/.git", `gitdir: ${modules}\n`)
    const nested = await ws.mkdirp("sub/pkg")

    const derived = await deriveFamilies([nested], ws.root)

    expect(derived.families.get(nested)?.familyKey).toBe(await realpath(modules))
    expect(derived.families.get(nested)?.survivor).toBe(await realpath(absolute(ws, "sub")))
  })

  it("A21: one lstat per ancestor per pass and no .git reads on .git-free ancestors", async () => {
    const ws = await workspace()
    const first = await plainProject(ws, "plain/a/b/c/first")
    const second = await plainProject(ws, "plain/a/b/c/second")

    trace.gitStats = 0
    trace.gitOpens = 0
    trace.recording = true
    const derived = await deriveFamilies([first, second], ws.root)
    trace.recording = false

    expect(derived.families.size).toBe(0)
    expect(derived.diagnostics).toEqual([])
    expect(trace.gitStats).toBe(6)
    expect(trace.gitOpens).toBe(0)
  })

  it("A22: an unreadable ancestor .git yields no family and one memoised diagnostic", async () => {
    const ws = await workspace()
    const git = await ws.write("broken/.git", "gitdir: nowhere\n")
    await chmod(git, 0o000)
    const first = await plainProject(ws, "broken/a/first")
    const second = await plainProject(ws, "broken/b/second")

    const derived = await deriveFamilies([first, second], ws.root)

    expect(derived.families.size).toBe(0)
    expect(derived.diagnostics).toEqual([
      `family: ${await realpath(absolute(ws, "broken"))}: unreadable .git: EACCES`,
    ])
  })
})
