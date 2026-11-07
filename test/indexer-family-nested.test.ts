import { realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { indexCandidates } from "../src/indexer.ts"
import { checkoutSkill, createFamilyWorkspace, nestedCheckoutSkill, plainProject, type FamilyWorkspace } from "./support/family-fixtures.ts"

const NESTED = "packages/app/.claude/skills"

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

const rootCandidate = async (ws: FamilyWorkspace, checkout: string, slug: string) =>
  ws.candidate(`${checkout}/.opencode/skills/${slug}/SKILL.md`, checkout)

const nestedCandidate = async (ws: FamilyWorkspace, checkout: string, relPath: string, slug: string) =>
  ws.candidate(`${checkout}/${relPath}/${slug}/SKILL.md`, `${checkout}/${relPath.split("/").slice(0, -2).join("/")}`)

const familyDiagnostics = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("family:"))

describe("nested subproject suppression in the index stage", () => {
  it("B15: a nested worktree twin is dropped and the survivor ids stay byte-identical", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await nestedCheckoutSkill(ws, "main", NESTED, "tidy")
    await checkoutSkill(ws, "wt", "deploy")
    await nestedCheckoutSkill(ws, "wt", NESTED, "tidy")
    const candidates = [
      await rootCandidate(ws, "main", "deploy"),
      await nestedCandidate(ws, "main", NESTED, "tidy"),
      await rootCandidate(ws, "wt", "deploy"),
      await nestedCandidate(ws, "wt", NESTED, "tidy"),
    ]

    const both = await indexCandidates(candidates, { location: ws.root })
    const alone = await indexCandidates(candidates.slice(0, 2), { location: ws.root })

    expect(both.skills).toHaveLength(2)
    expect(both.skills.map((skill) => skill.id)).toEqual(alone.skills.map((skill) => skill.id))
    expect(both.skills.map((skill) => skill.subproject).sort()).toEqual(["main", "main/packages/app"])
    expect(familyDiagnostics(both.diagnostics)).toHaveLength(2)
  })

  it("B16: a worktree-only nested skill is dropped as missing at the survivor", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await nestedCheckoutSkill(ws, "wt", NESTED, "tidy")

    const result = await indexCandidates(
      [await rootCandidate(ws, "main", "deploy"), await nestedCandidate(ws, "wt", NESTED, "tidy")],
      { location: ws.root },
    )
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    expect(result.skills.map((skill) => skill.nativeName)).toEqual(["deploy"])
    expect(result.diagnostics).toContain(
      `family: suppressed ${NESTED}/tidy/SKILL.md from ${wtReal} (missing at survivor ${mainReal})`,
    )
  })

  it("B17: nested entries pair on the checkout-relative path", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await nestedCheckoutSkill(ws, "main", NESTED, "tidy")
    await nestedCheckoutSkill(ws, "wt", NESTED, "tidy")

    const result = await indexCandidates(
      [await nestedCandidate(ws, "main", NESTED, "tidy"), await nestedCandidate(ws, "wt", NESTED, "tidy")],
      { location: ws.root },
    )
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.subproject).toBe("main/packages/app")
    expect(result.diagnostics).toContain(
      `family: suppressed ${NESTED}/tidy/SKILL.md from ${wtReal} (survivor ${mainReal} has it)`,
    )
  })

  it("B18: a nested subproject with no .git ancestor inside the location is kept silently", async () => {
    const ws = await workspace()
    await plainProject(ws, "plain/packages/app")
    await nestedCheckoutSkill(ws, "plain", NESTED, "tidy")

    const result = await indexCandidates([await nestedCandidate(ws, "plain", NESTED, "tidy")], {
      location: ws.root,
    })

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.subproject).toBe("plain/packages/app")
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B19: a nested subproject inside a submodule is kept", async () => {
    const ws = await workspace()
    await ws.repo("parent")
    const modules = await ws.mkdirp("parent/.git/modules/sub")
    await ws.write("sub/.git", `gitdir: ${modules}\n`)
    await nestedCheckoutSkill(ws, "sub", NESTED, "tidy")

    const result = await indexCandidates([await nestedCandidate(ws, "sub", NESTED, "tidy")], {
      location: ws.root,
    })

    expect(result.skills).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B20: a nested subproject inside a sibling repo is kept", async () => {
    const ws = await workspace()
    await ws.repo("one")
    await ws.repo("two")
    await nestedCheckoutSkill(ws, "one", NESTED, "tidy")

    const result = await indexCandidates([await nestedCandidate(ws, "one", NESTED, "tidy")], {
      location: ws.root,
    })

    expect(result.skills).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B21: shuffled input yields the same nested skills and diagnostics", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await nestedCheckoutSkill(ws, "main", NESTED, "tidy")
    await checkoutSkill(ws, "wt", "deploy")
    await nestedCheckoutSkill(ws, "wt", NESTED, "tidy")
    const candidates = [
      await rootCandidate(ws, "main", "deploy"),
      await nestedCandidate(ws, "main", NESTED, "tidy"),
      await rootCandidate(ws, "wt", "deploy"),
      await nestedCandidate(ws, "wt", NESTED, "tidy"),
    ]

    const forward = await indexCandidates(candidates, { location: ws.root })
    const reversed = await indexCandidates([...candidates].reverse(), { location: ws.root })

    expect(forward.skills).toHaveLength(2)
    expect(reversed.skills).toEqual(forward.skills)
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
  })
})
