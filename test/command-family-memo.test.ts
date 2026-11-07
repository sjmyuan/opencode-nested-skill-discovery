import { chmod, realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { filterCommandFamilies } from "../src/command-family.ts"
import { createFamilyPass } from "../src/family.ts"
import { indexCandidates, type IndexedSkill } from "../src/indexer.ts"
import { createFamilyWorkspace, checkoutSkill, nestedCheckoutSkill, type FamilyWorkspace } from "./support/family-fixtures.ts"
import { scanCommands, writeCommand } from "./support/command-family-fixtures.ts"

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

const NESTED = "packages/app/.opencode/skills"

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

const gitTrace = async <T>(run: () => Promise<T>): Promise<{ stats: number; opens: number }> => {
  trace.gitStats = 0
  trace.gitOpens = 0
  trace.recording = true
  try {
    await run()
  } finally {
    trace.recording = false
  }
  return { stats: trace.gitStats, opens: trace.gitOpens }
}

const familyLines = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("family:"))

/** Main + linked worktree, each with a root and a nested skill and command of the same name. */
const buildWorkspace = async (): Promise<FamilyWorkspace> => {
  const ws = await workspace()
  await ws.repo("main")
  await ws.worktree("wt", "main", "linked")
  for (const checkout of ["main", "wt"]) {
    await checkoutSkill(ws, checkout, "deploy")
    await nestedCheckoutSkill(ws, checkout, NESTED, "tidy")
    await writeCommand(ws, checkout, "command", "deploy.md")
    await writeCommand(ws, `${checkout}/packages/app`, "commands", "tidy.md")
  }
  return ws
}

const skillCandidates = async (ws: FamilyWorkspace) => [
  await ws.candidate("main/.opencode/skills/deploy/SKILL.md", "main"),
  await ws.candidate("main/packages/app/.opencode/skills/tidy/SKILL.md", "main/packages/app"),
  await ws.candidate("wt/.opencode/skills/deploy/SKILL.md", "wt"),
  await ws.candidate("wt/packages/app/.opencode/skills/tidy/SKILL.md", "wt/packages/app"),
]

describe("one memo per refresh across the skill and command stages", () => {
  it("M1: the skill and command passes share one checkout memo: no extra .git lstat or read", async () => {
    const ws = await buildWorkspace()
    const candidates = await skillCandidates(ws)
    const commands = await scanCommands(ws)

    const skillOnly = await gitTrace(async () => {
      await indexCandidates(candidates, { location: ws.root, family: await createFamilyPass(ws.root) })
    })

    const pass = await createFamilyPass(ws.root)
    const shared = await gitTrace(async () => {
      await indexCandidates(candidates, { location: ws.root, family: pass })
      await filterCommandFamilies(commands, { family: pass })
    })

    expect(commands).toHaveLength(4)
    expect(skillOnly.stats).toBeGreaterThan(0)
    expect(skillOnly.opens).toBeGreaterThan(0)
    expect(shared).toEqual(skillOnly)
  })

  it("M2: an unreadable .git is reported once per pass across skills and commands", async () => {
    const ws = await workspace()
    await ws.repo("main")
    const git = await ws.write("wt/.git", "gitdir: nowhere\n")
    await chmod(git, 0o000)
    await checkoutSkill(ws, "wt", "deploy")
    await writeCommand(ws, "wt", "command", "deploy.md")
    const wtReal = await realpath(absolute(ws, "wt"))
    const pass = await createFamilyPass(ws.root)

    const indexed = await indexCandidates(
      [await ws.candidate("wt/.opencode/skills/deploy/SKILL.md", "wt")],
      { location: ws.root, family: pass },
    )
    const filtered = await filterCommandFamilies(await scanCommands(ws), { family: pass })

    expect([...indexed.diagnostics, ...filtered.diagnostics].filter((line) => line.startsWith("family:"))).toEqual([
      `family: ${wtReal}: unreadable .git: EACCES`,
    ])
    expect(filtered.commands).toHaveLength(1)
  })

  it("M3: sharing the pass leaves the skill result byte-identical", async () => {
    const ws = await buildWorkspace()
    const candidates = await skillCandidates(ws)
    const commands = await scanCommands(ws)

    const standalone = await indexCandidates(candidates, { location: ws.root })
    const pass = await createFamilyPass(ws.root)
    const shared = await indexCandidates(candidates, { location: ws.root, family: pass })
    await filterCommandFamilies(commands, { family: pass })
    const afterCommands = await indexCandidates(candidates, { location: ws.root, family: pass })

    const shape = (skills: readonly IndexedSkill[]) =>
      skills.map((skill) => ({
        id: skill.id,
        name: skill.nativeName,
        path: skill.canonicalPath,
        subproject: skill.subproject,
      }))

    expect(standalone.skills).toHaveLength(2)
    expect(shape(shared.skills)).toEqual(shape(standalone.skills))
    expect(shared.skills).toEqual(standalone.skills)
    expect(shared.diagnostics).toEqual(standalone.diagnostics)
    expect(afterCommands.skills).toEqual(standalone.skills)
    expect(afterCommands.diagnostics).toEqual(standalone.diagnostics)
  })

  it("M4: an empty command list performs no family resolution", async () => {
    const ws = await buildWorkspace()
    const pass = await createFamilyPass(ws.root)

    const counts = await gitTrace(async () => {
      await filterCommandFamilies([], { family: pass })
    })

    expect(counts).toEqual({ stats: 0, opens: 0 })
  })
})
