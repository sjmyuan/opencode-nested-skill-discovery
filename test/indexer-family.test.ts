import { realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { scopeTokenFor, skillTokenFor, indexCandidates } from "../src/indexer.ts"
import { only } from "./support/indexer-fixtures.ts"
import { checkoutSkill, createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

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

const candidateOf = async (ws: FamilyWorkspace, checkout: string, slug: string) =>
  ws.candidate(`${checkout}/.opencode/skills/${slug}/SKILL.md`, checkout)

const familyDiagnostics = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("family:"))

describe("repo-family suppression in the index stage", () => {
  it("B1: drops the worktree copy and keeps the survivor id byte-identical", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    const mainFile = await checkoutSkill(ws, "main", "deploy")
    await checkoutSkill(ws, "wt", "deploy")
    const main = await candidateOf(ws, "main", "deploy")
    const wt = await candidateOf(ws, "wt", "deploy")

    const both = await indexCandidates([main, wt], { location: ws.root })
    const alone = await indexCandidates([main], { location: ws.root })
    const mainReal = await realpath(absolute(ws, "main"))

    expect(both.skills).toHaveLength(1)
    expect(only(both.skills).id).toBe(only(alone.skills).id)
    expect(only(both.skills).id).toBe(
      `nested.${scopeTokenFor(mainReal)}.${skillTokenFor("deploy", await realpath(mainFile))}`,
    )
    expect(only(both.skills).subproject).toBe("main")
  })

  it("B2: drops a worktree-only skill with a missing-at-survivor diagnostic", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await checkoutSkill(ws, "wt", "tidy")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await indexCandidates(
      [await candidateOf(ws, "main", "deploy"), await candidateOf(ws, "wt", "tidy")],
      { location: ws.root },
    )

    expect(result.skills.map((skill) => skill.nativeName)).toEqual(["deploy"])
    expect(result.diagnostics).toContain(
      `family: suppressed .opencode/skills/tidy/SKILL.md from ${wtReal} (missing at survivor ${mainReal})`,
    )
  })

  it("B3: a duplicate repo-relative skill reports that the survivor has it", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await checkoutSkill(ws, "wt", "deploy")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await indexCandidates(
      [await candidateOf(ws, "main", "deploy"), await candidateOf(ws, "wt", "deploy")],
      { location: ws.root },
    )

    expect(result.diagnostics).toContain(
      `family: suppressed .opencode/skills/deploy/SKILL.md from ${wtReal} (survivor ${mainReal} has it)`,
    )
  })

  it("B3b: pairs against the survivor's post-dedupe entries, not the raw list", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await ws.write("main/.opencode/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy\n")
    await ws.write("main/.claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy again\n")
    await ws.write("wt/.claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy third\n")
    const mainDeploy = await ws.candidate("main/.opencode/skills/deploy/SKILL.md", "main")
    const mainClaude = await ws.candidate("main/.claude/skills/deploy/SKILL.md", "main")
    const wtClaude = await ws.candidate("wt/.claude/skills/deploy/SKILL.md", "wt")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await indexCandidates([mainDeploy, mainClaude, wtClaude], { location: ws.root })

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.canonicalPath).toBe(await realpath(absolute(ws, "main/.opencode/skills/deploy/SKILL.md")))
    expect(result.diagnostics).toContain(
      `family: suppressed .claude/skills/deploy/SKILL.md from ${wtReal} (missing at survivor ${mainReal})`,
    )
  })

  it("B4: one diagnostic per dropped entry", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await checkoutSkill(ws, "wt", "deploy")
    await checkoutSkill(ws, "wt", "tidy")
    await checkoutSkill(ws, "wt", "lint")

    const result = await indexCandidates(
      [
        await candidateOf(ws, "main", "deploy"),
        await candidateOf(ws, "wt", "deploy"),
        await candidateOf(ws, "wt", "tidy"),
        await candidateOf(ws, "wt", "lint"),
      ],
      { location: ws.root },
    )

    expect(result.skills).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toHaveLength(3)
  })

  it("B5: survivor entries are never dropped by the family rule", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    for (const slug of ["deploy", "tidy", "lint"]) await checkoutSkill(ws, "main", slug)
    await checkoutSkill(ws, "wt", "deploy")

    const result = await indexCandidates(
      [
        await candidateOf(ws, "main", "deploy"),
        await candidateOf(ws, "main", "tidy"),
        await candidateOf(ws, "main", "lint"),
        await candidateOf(ws, "wt", "deploy"),
      ],
      { location: ws.root },
    )

    expect(result.skills).toHaveLength(3)
    expect(result.skills.every((skill) => skill.subproject === "main")).toBe(true)
  })

  it("B6: the native root filter still runs first and emits no family line", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await checkoutSkill(ws, "wt", "deploy")

    const result = await indexCandidates(
      [await candidateOf(ws, "main", "deploy"), await candidateOf(ws, "wt", "deploy")],
      { location: ws.root, nativeRoots: [absolute(ws, "wt/.opencode/skills")] },
    )

    expect(result.skills.map((skill) => skill.subproject)).toEqual(["main"])
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B7: a location at the worktree publishes its own view", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "wt", "effect")
    const location = absolute(ws, "wt")

    const result = await indexCandidates([await ws.candidate("wt/.opencode/skills/effect/SKILL.md", "")], {
      location,
    })

    expect(result.skills).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B8: a survivor outside the location suppresses nothing", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("ws/wt", "main", "linked")
    await checkoutSkill(ws, "ws/wt", "deploy")

    const result = await indexCandidates([await ws.candidate("ws/wt/.opencode/skills/deploy/SKILL.md", "wt")], {
      location: absolute(ws, "ws"),
    })

    expect(result.skills).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B9: distinct subprojects of one repo do not collapse", async () => {
    const ws = await workspace()
    await ws.repo("vscode")
    await checkoutSkill(ws, "vscode", "launch")
    await checkoutSkill(ws, "vscode/extensions/copilot", "launch")

    const result = await indexCandidates(
      [
        await candidateOf(ws, "vscode", "launch"),
        await ws.candidate("vscode/extensions/copilot/.opencode/skills/launch/SKILL.md", "vscode/extensions/copilot"),
      ],
      { location: ws.root },
    )

    expect(result.skills).toHaveLength(2)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B10: sibling repos stay separate", async () => {
    const ws = await workspace()
    await ws.repo("one")
    await ws.repo("two")
    await checkoutSkill(ws, "one", "deploy")
    await checkoutSkill(ws, "two", "deploy")

    const result = await indexCandidates([await candidateOf(ws, "one", "deploy"), await candidateOf(ws, "two", "deploy")], {
      location: ws.root,
    })

    expect(result.skills).toHaveLength(2)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B11: a submodule checkout is never suppressed by its parent repo", async () => {
    const ws = await workspace()
    await ws.repo("parent")
    const modules = await ws.mkdirp("parent/.git/modules/sub")
    await ws.write("sub/.git", `gitdir: ${modules}\n`)
    await checkoutSkill(ws, "parent", "deploy")
    await checkoutSkill(ws, "sub", "deploy")

    const result = await indexCandidates(
      [await candidateOf(ws, "parent", "deploy"), await candidateOf(ws, "sub", "deploy")],
      { location: ws.root },
    )

    expect(result.skills).toHaveLength(2)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B12: a subproject that is the location itself is never suppressed", async () => {
    const ws = await workspace()
    await ws.repo("")
    await checkoutSkill(ws, "", "root-skill")

    const result = await indexCandidates([await ws.candidate(".opencode/skills/root-skill/SKILL.md", "")], {
      location: ws.root,
    })

    expect(result.skills).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("B13: shuffled input yields the same skills and diagnostics", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    for (const slug of ["deploy", "tidy"]) await checkoutSkill(ws, "main", slug)
    for (const slug of ["deploy", "lint"]) await checkoutSkill(ws, "wt", slug)
    const candidates = [
      await candidateOf(ws, "main", "deploy"),
      await candidateOf(ws, "main", "tidy"),
      await candidateOf(ws, "wt", "deploy"),
      await candidateOf(ws, "wt", "lint"),
    ]

    const forward = await indexCandidates(candidates, { location: ws.root })
    const reversed = await indexCandidates([...candidates].reverse(), { location: ws.root })

    expect(reversed.skills).toEqual(forward.skills)
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
    expect(forward.skills).toHaveLength(2)
  })

  it("B14: a broken .git publishes the pre-suppression entries with one diagnostic", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.write("wt/.git", "garbage\n")
    await checkoutSkill(ws, "main", "deploy")
    await checkoutSkill(ws, "wt", "deploy")
    const wtReal = await realpath(absolute(ws, "wt"))

    const result = await indexCandidates(
      [await candidateOf(ws, "main", "deploy"), await candidateOf(ws, "wt", "deploy")],
      { location: ws.root },
    )

    expect(result.skills).toHaveLength(2)
    expect(result.diagnostics).toContain(`family: ${wtReal}: no gitdir line`)
  })
})
