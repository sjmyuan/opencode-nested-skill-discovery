import { realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createFamilyPass, deriveFamilies, type FamilyPass } from "../src/family.ts"
import { indexCandidates } from "../src/indexer.ts"
import { checkoutSkill, createFamilyWorkspace, nestedCheckoutSkill, type FamilyWorkspace } from "./support/family-fixtures.ts"

const NESTED = "packages/app/.opencode/skills"

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

const familyDiagnostics = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("family:"))

const gitTrace = async (run: () => Promise<void>): Promise<{ stats: number; opens: number }> => {
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

const absolute = (ws: FamilyWorkspace, relativePath: string): string => path.join(ws.root, relativePath)

describe("one family pass per refresh", () => {
  it("P1: a pass reuses its checkout memo across two resolutions", async () => {
    const ws = await workspace()
    await ws.repo("main")
    const nested = await ws.mkdirp("main/packages/app")
    const pass: FamilyPass = await createFamilyPass(ws.root)

    const first = await gitTrace(async () => {
      await pass.derive([nested])
    })
    const second = await gitTrace(async () => {
      await pass.derive([nested])
    })

    expect(first.stats).toBeGreaterThan(0)
    expect(second).toEqual({ stats: 0, opens: 0 })
  })

  it("P2: a pass reports one family diagnostic however many resolutions hit it", async () => {
    const ws = await workspace()
    const broken = await ws.mkdirp("broken")
    await ws.write("broken/.git", "garbage\n")
    const pass = await createFamilyPass(ws.root)

    const first = await pass.derive([broken])
    const second = await pass.derive([broken])

    expect(familyDiagnostics(first.diagnostics)).toHaveLength(1)
    expect(familyDiagnostics(second.diagnostics)).toHaveLength(0)
    expect([...first.diagnostics, ...second.diagnostics]).toEqual([
      `family: ${await realpath(absolute(ws, "broken"))}: no gitdir line`,
    ])
    expect(first.families.size).toBe(0)
  })

  it("P3: deriveFamilies still reports once per call", async () => {
    const ws = await workspace()
    const broken = await ws.mkdirp("broken")
    await ws.write("broken/.git", "garbage\n")

    const first = await deriveFamilies([broken], ws.root)
    const second = await deriveFamilies([broken], ws.root)

    expect(first.diagnostics).toEqual([`family: ${await realpath(absolute(ws, "broken"))}: no gitdir line`])
    expect(second.diagnostics).toEqual(first.diagnostics)
  })

  it("P4: indexCandidates accepts an injected pass and returns the same skills and diagnostics", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await checkoutSkill(ws, "main", "deploy")
    await nestedCheckoutSkill(ws, "main", NESTED, "tidy")
    await checkoutSkill(ws, "wt", "deploy")
    await nestedCheckoutSkill(ws, "wt", NESTED, "tidy")
    const candidates = [
      await ws.candidate("main/.opencode/skills/deploy/SKILL.md", "main"),
      await ws.candidate(`main/${NESTED}/tidy/SKILL.md`, "main/packages/app"),
      await ws.candidate("wt/.opencode/skills/deploy/SKILL.md", "wt"),
      await ws.candidate(`wt/${NESTED}/tidy/SKILL.md`, "wt/packages/app"),
    ]
    const pass = await createFamilyPass(ws.root)

    const injected = await indexCandidates(candidates, { location: ws.root, family: pass })
    const standalone = await indexCandidates(candidates, { location: ws.root })
    const warm = await gitTrace(async () => {
      await indexCandidates(candidates, { location: ws.root, family: pass })
    })

    expect(injected.skills).toEqual(standalone.skills)
    expect(injected.diagnostics).toEqual(standalone.diagnostics)
    expect(injected.skills).toHaveLength(2)
    expect(warm).toEqual({ stats: 0, opens: 0 })
  })
})
