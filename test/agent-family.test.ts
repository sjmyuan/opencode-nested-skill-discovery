import { realpath } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { AgentCandidate } from "../src/contracts.ts"
import { filterAgentFamilies } from "../src/agent-family.ts"
import { createFamilyPass } from "../src/family.ts"
import { scanSkills } from "../src/scan.ts"
import { only } from "./support/indexer-fixtures.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

/**
 * F15 Step 5 (ADR agent A11): agent candidates reuse the delivered repo-family stage
 * (R18–R20) before any identity work, pairing on the checkout-relative POSIX path through
 * the shared per-pass checkout memo. The module ships unwired — F16 consumes it.
 */

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

const writeAgent = (ws: FamilyWorkspace, checkout: string, root: "agent" | "agents", relName: string) =>
  ws.write(path.posix.join(checkout, ".opencode", root, relName), `# ${relName}\n`)

const scanAgents = async (ws: FamilyWorkspace, location: string = ws.root): Promise<readonly AgentCandidate[]> =>
  (await scanSkills({ location })).agents

const filtered = async (ws: FamilyWorkspace, location: string = ws.root) =>
  filterAgentFamilies(await scanAgents(ws, location), { family: await createFamilyPass(location) })

const familyDiagnostics = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("family:"))

describe("agent candidates reuse the repo-family rule", () => {
  it("drops a worktree agent and keeps the main checkout's, with one diagnostic", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await writeAgent(ws, "main", "agent", "triage.md")
    await writeAgent(ws, "wt", "agent", "triage.md")
    const mainReal = await realpath(absolute(ws, "main"))
    const wtReal = await realpath(absolute(ws, "wt"))

    const result = await filtered(ws)

    expect(result.agents).toHaveLength(1)
    expect(only(result.agents).name).toBe("triage")
    expect(only(result.agents).subproject).toBe("main")
    expect(result.diagnostics).toEqual([
      `family: suppressed .opencode/agent/triage.md from ${wtReal} (survivor ${mainReal} has it)`,
    ])
  })

  it("pairs on the checkout-relative path, never on the agent name", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await writeAgent(ws, "main", "agent", "triage.md")
    await writeAgent(ws, "wt", "agent", "triage.md")
    // Same native name, different checkout-relative path: the delivered R18–R20 rule
    // reports it as missing at the survivor rather than as a paired duplicate.
    await writeAgent(ws, "wt", "agents", "triage.md")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await filtered(ws)

    expect(result.agents.map((agent) => `${agent.subproject}:${agent.name}`)).toEqual(["main:triage"])
    expect(result.diagnostics).toEqual([
      `family: suppressed .opencode/agent/triage.md from ${wtReal} (survivor ${mainReal} has it)`,
      `family: suppressed .opencode/agents/triage.md from ${wtReal} (missing at survivor ${mainReal})`,
    ])
  })

  it("suppresses a nested subproject inside a suppressed checkout", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await writeAgent(ws, "main/nested", "agents", "x.md")
    await writeAgent(ws, "wt/nested", "agents", "x.md")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await filtered(ws)

    expect(result.agents).toHaveLength(1)
    expect(only(result.agents).subproject).toBe("main/nested")
    expect(only(result.agents).name).toBe("x")
    expect(only(result.diagnostics)).toBe(
      `family: suppressed nested/.opencode/agents/x.md from ${wtReal} (survivor ${mainReal} has it)`,
    )
  })

  it("keeps a checkout with no family silently", async () => {
    const ws = await workspace()
    await ws.mkdirp("plain")
    await writeAgent(ws, "plain", "agent", "solo.md")

    const result = await filtered(ws)

    expect(result.agents).toHaveLength(1)
    expect(result.diagnostics).toEqual([])
  })

  it("returns an empty list unchanged with no diagnostics", async () => {
    const ws = await workspace()

    const result = await filterAgentFamilies([], { family: await createFamilyPass(ws.root) })

    expect(result).toEqual({ agents: [], diagnostics: [] })
  })

  it("sorts by canonical path then path and is stable for a reversed input", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    for (const name of ["triage", "lint"]) await writeAgent(ws, "main", "agent", `${name}.md`)
    for (const name of ["triage", "lint"]) await writeAgent(ws, "wt", "agent", `${name}.md`)
    const agents = await scanAgents(ws)
    const pass = await createFamilyPass(ws.root)

    const forward = await filterAgentFamilies(agents, { family: pass })
    const reversed = await filterAgentFamilies([...agents].reverse(), { family: pass })

    expect(reversed.agents).toEqual(forward.agents)
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
    expect(forward.agents.map((agent) => agent.canonicalPath)).toEqual(
      [...forward.agents.map((agent) => agent.canonicalPath)].sort(),
    )
    expect(familyDiagnostics(forward.diagnostics)).toHaveLength(2)
  })
})
