import { chmod, realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { deriveFamilies, isOwnedCommonDir, resolveRepoFamily } from "../src/family.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

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

describe("repo family derivation", () => {
  it("A1: a .git directory is its own family and its own survivor", async () => {
    const ws = await workspace()
    await ws.repo("main")

    const resolution = await resolveRepoFamily(absolute(ws, "main"))

    expect(resolution.diagnostic).toBeUndefined()
    expect(resolution.family).toEqual({
      familyKey: await realpath(absolute(ws, "main/.git")),
      survivor: await realpath(absolute(ws, "main")),
    })
  })

  it("A2: a .git file under <main>/.git/worktrees names the main checkout", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")

    const resolution = await resolveRepoFamily(absolute(ws, "wt"))

    expect(resolution.diagnostic).toBeUndefined()
    expect(resolution.family).toEqual({
      familyKey: await realpath(absolute(ws, "main/.git")),
      survivor: await realpath(absolute(ws, "main")),
    })
  })

  it("A3: a worktree of a worktree shares the same common dir and survivor", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("first", "main", "one")
    await ws.worktree("second", "main", "two")

    const first = await resolveRepoFamily(absolute(ws, "first"))
    const second = await resolveRepoFamily(absolute(ws, "second"))

    expect(first.family).toEqual(second.family)
    expect(first.family?.survivor).toBe(await realpath(absolute(ws, "main")))
  })

  it("A4: a submodule gitdir under .git/modules stays its own family", async () => {
    const ws = await workspace()
    await ws.repo("parent")
    const modules = await ws.mkdirp("parent/.git/modules/sub")
    await ws.write("sub/.git", `gitdir: ${modules}\n`)

    const resolution = await resolveRepoFamily(absolute(ws, "sub"))

    expect(resolution.diagnostic).toBeUndefined()
    expect(resolution.family).toEqual({
      familyKey: await realpath(modules),
      survivor: await realpath(absolute(ws, "sub")),
    })
  })

  it("A5: a foreign gitdir target is its own family, never the parent", async () => {
    const ws = await workspace()
    const foreign = await ws.mkdirp("elsewhere/store")
    await ws.write("wt/.git", `gitdir: ${foreign}\n`)

    const resolution = await resolveRepoFamily(absolute(ws, "wt"))

    expect(resolution.diagnostic).toBeUndefined()
    expect(resolution.family).toEqual({
      familyKey: await realpath(foreign),
      survivor: await realpath(absolute(ws, "wt")),
    })
  })

  it("A6: a worktrees/<n> target whose common dir is not .git yields no family", async () => {
    const ws = await workspace()
    await ws.mkdirp("plain/worktrees/linked")
    const checkout = absolute(ws, "wt")
    await ws.write("wt/.git", `gitdir: ${absolute(ws, "plain/worktrees/linked")}\n`)

    const resolution = await resolveRepoFamily(checkout)

    expect(resolution.family).toBeUndefined()
    expect(resolution.diagnostic).toBe(`family: ${checkout}: common dir not a parent .git`)
  })

  it("A7: a common dir only counts when its parent owns it", async () => {
    const ws = await workspace()
    await ws.repo("owner")
    const elsewhere = await ws.mkdirp("holder/.git")
    await ws.link("alias/.git", elsewhere)

    expect(await isOwnedCommonDir(await realpath(absolute(ws, "owner/.git")))).toBe(true)
    expect(await isOwnedCommonDir(absolute(ws, "alias/.git"))).toBe(false)
  })

  it("A8: an absent .git resolves no family and no diagnostic", async () => {
    const ws = await workspace()
    const plain = await ws.mkdirp("plain")
    await ws.repo("main")

    const derived = await deriveFamilies([plain, absolute(ws, "main")], ws.root)

    expect(derived.families.has(plain)).toBe(false)
    expect(derived.families.size).toBe(1)
    expect(derived.diagnostics).toEqual([])
  })

  it("A9: an unreadable .git resolves no family and reports the code", async () => {
    const ws = await workspace()
    const checkout = absolute(ws, "broken")
    const git = await ws.write("broken/.git", "gitdir: nowhere\n")
    await chmod(git, 0o000)

    const resolution = await resolveRepoFamily(checkout)

    expect(resolution.family).toBeUndefined()
    expect(resolution.diagnostic).toBe(`family: ${checkout}: unreadable .git: EACCES`)
  })

  it("A10: a garbage .git reports the missing gitdir line", async () => {
    const ws = await workspace()
    const checkout = absolute(ws, "broken")
    await ws.write("broken/.git", "this is not a git file\n")

    const resolution = await resolveRepoFamily(checkout)

    expect(resolution.family).toBeUndefined()
    expect(resolution.diagnostic).toBe(`family: ${checkout}: no gitdir line`)
  })

  it("A11: a dangling gitdir target reports the resolution failure", async () => {
    const ws = await workspace()
    const checkout = absolute(ws, "broken")
    await ws.write("broken/.git", "gitdir: ../missing/.git/worktrees/gone\n")

    const resolution = await resolveRepoFamily(checkout)

    expect(resolution.family).toBeUndefined()
    expect(resolution.diagnostic).toBe(`family: ${checkout}: gitdir target unresolvable: ENOENT`)
  })

  it("A12: a gitdir line beyond 4 KB degrades to the missing-line diagnostic", async () => {
    const ws = await workspace()
    await ws.repo("main")
    const checkout = absolute(ws, "broken")
    const target = absolute(ws, "main/.git/worktrees/linked")
    await ws.write("broken/.git", `${"x".repeat(5000)}\ngitdir: ${target}\n`)

    const resolution = await resolveRepoFamily(checkout)

    expect(resolution.family).toBeUndefined()
    expect(resolution.diagnostic).toBe(`family: ${checkout}: no gitdir line`)
  })

  it("A13: a symlinked checkout alias resolves to one family", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.link("alias", "main")

    const derived = await deriveFamilies([absolute(ws, "alias"), absolute(ws, "main")], ws.root)
    const families = [...derived.families.values()]

    expect(derived.diagnostics).toEqual([])
    expect(families).toHaveLength(2)
    expect(new Set(families.map((family) => family.familyKey)).size).toBe(1)
    expect(new Set(families.map((family) => family.survivor)).size).toBe(1)
    expect(families[0]?.survivor).toBe(await realpath(absolute(ws, "main")))
  })

  it("A14: casing is preserved and never lowercased", async () => {
    const ws = await workspace()
    await ws.repo("MixedCase")

    const resolution = await resolveRepoFamily(absolute(ws, "MixedCase"))

    expect(resolution.family?.survivor).toBe(await realpath(absolute(ws, "MixedCase")))
    expect(resolution.family?.survivor.endsWith("MixedCase")).toBe(true)
    expect(resolution.family?.familyKey.endsWith(path.join("MixedCase", ".git"))).toBe(true)
  })

  it("A15: a broken checkout yields one diagnostic per pass, whatever the call count", async () => {
    const ws = await workspace()
    await ws.write("broken/.git", "garbage\n")
    await ws.write("other/.git", "garbage\n")
    const broken = absolute(ws, "broken")
    const other = absolute(ws, "other")

    const once = await deriveFamilies([broken, broken, broken], ws.root)
    const twice = await deriveFamilies([broken, other], ws.root)

    expect(once.diagnostics).toEqual([`family: ${broken}: no gitdir line`])
    expect(twice.diagnostics).toEqual([
      `family: ${broken}: no gitdir line`,
      `family: ${other}: no gitdir line`,
    ])
  })
})
