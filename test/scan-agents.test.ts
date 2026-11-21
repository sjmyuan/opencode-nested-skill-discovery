import { afterEach, describe, expect, it } from "vitest"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, createOutside, type ScanFixture } from "./support/scan-fixtures.ts"

/**
 * F15 Step 3: `<subproject>/.opencode/{agent,agents}/**\/*.md` on the walk already paid for
 * (ADR agent A1, A12; contract C2 agent branch).
 *
 * Native parity: the name is the root-relative POSIX path with one trailing `.md` stripped —
 * dots kept, inner separators kept (`packages/core/src/config/plugin/agent.ts:157-161`).
 */

const cleanups: Array<() => Promise<void>> = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("agent roots", () => {
  it("collects one agent file with its native name, owner and realpath", async () => {
    const f = await fixture()
    const abs = await f.write("A/.opencode/agent/translator.md")

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]).toEqual({
      name: "translator",
      path: abs.replace(f.root, f.realRoot),
      canonicalPath: await realpath(abs),
      subproject: "A",
      subprojectRealPath: await realpath(join(f.root, "A")),
      root: "opencode-agent",
      markers: ["opencode-project"],
    })
  })

  it("keeps a nested path inside the agents root as the native name", async () => {
    const f = await fixture()
    await f.write("A/.opencode/agents/review-tools/pr.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]?.name).toBe("review-tools/pr")
    expect(result.agents[0]?.root).toBe("opencode-agents")
    expect(result.agents[0]?.name).not.toContain("\\")
    expect(result.agents[0]?.name).not.toContain(".md")
  })

  it("keeps dot files, dot directories and arbitrary depth inside an opened root", async () => {
    const f = await fixture()
    await f.write("A/.opencode/agent/.hidden.md")
    await f.write("A/.opencode/agent/.archive/old.md")
    await f.write("A/.opencode/agent/team/deep/x.md")
    await f.write("A/.opencode/agent/notes.txt")
    await f.write("A/.opencode/agent/README")

    const result = await scanSkills({ location: f.root })

    expect(result.agents.map((agent) => agent.name)).toEqual([".archive/old", ".hidden", "team/deep/x"])
    expect(result.truncated).toBe(false)
  })

  it("discovers both agent roots in one subproject", async () => {
    const f = await fixture()
    await f.write("A/.opencode/agent/one.md")
    await f.write("A/.opencode/agents/two.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agents.map((agent) => `${agent.root}:${agent.name}`)).toEqual([
      "opencode-agent:one",
      "opencode-agents:two",
    ])
  })

  it("never scans the location's own agent root and reports nothing about it", async () => {
    const f = await fixture()
    await f.write(".opencode/agent/self.md")
    await f.write(".opencode/agents/self-two.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agents).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("never scans a sibling config directory's agent folders", async () => {
    const f = await fixture()
    await f.write("A/.claude/agents/x.md")
    await f.write("A/.claude/agent/y.md")
    await f.write("A/.agents/agent/z.md")
    await f.write("A/.agents/agents/w.md")
    await f.write("A/.opencode/mode/m.md")
    await f.write("A/.opencode/modes/n.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agents).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("scans a subproject at maxDepth but not at maxDepth + 1", async () => {
    const f = await fixture()
    await f.write("L1/L2/L3/L4/L5/.opencode/agent/five.md")
    await f.write("M1/M2/M3/M4/M5/M6/.opencode/agent/six.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agents.map((agent) => agent.subproject)).toEqual(["L1/L2/L3/L4/L5"])
  })

  it("shares the file budget with skills and commands", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/x/SKILL.md", "a")
    await f.write("A/.opencode/agent/y.md", "b")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFiles: 1 },
    })

    expect(result.truncated).toBe(true)
    expect(result.diagnostics).toEqual(["budget-files: maxFiles=1"])
    expect(result.candidates.length + result.agents.length).toBe(1)
  })

  it("shares the total-byte budget with skills and commands", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/x/SKILL.md", "a")
    await f.write("A/.opencode/agent/y.md", "b")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxTotalBytes: 1 },
    })

    expect(result.truncated).toBe(true)
    expect(result.diagnostics).toEqual(["budget-total-bytes: maxTotalBytes=1"])
    expect(result.candidates.length + result.agents.length).toBe(1)
  })

  it("treats a symlinked agent file inside the location as a candidate of its target", async () => {
    const f = await fixture()
    const target = await f.write("shared/agent.md")
    const link = await f.symlink("A/.opencode/agent/alias.md", "../../../shared/agent.md")

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]?.name).toBe("alias")
    expect(result.agents[0]?.path).toBe(link.replace(f.root, f.realRoot))
    expect(result.agents[0]?.canonicalPath).toBe(await realpath(target))
  })

  it("reports a symlinked agent file that escapes the location, and one that points at a directory", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    await outside.write("agent.md")
    await f.symlink("A/.opencode/agent/out.md", join(outside.root, "agent.md"))
    await f.symlink("A/.opencode/agent/dir.md", outside.root)

    const result = await scanSkills({ location: f.root })

    expect(result.agents).toEqual([])
    expect(result.diagnostics).toEqual([
      "directory-symlink: A/.opencode/agent/dir.md",
      "file-symlink-outside: A/.opencode/agent/out.md",
    ])
  })

  it("returns an empty agent list and an unchanged result when no agent root exists", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/x/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agents).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.commands).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("orders agents deterministically by canonical path", async () => {
    const f = await fixture()
    await f.write("B/.opencode/agent/b.md")
    await f.write("A/.opencode/agents/a.md")
    await f.write("B/.opencode/agent/deep/a.md")

    const first = await scanSkills({ location: f.root })
    const second = await scanSkills({ location: f.root })

    const relPaths = first.agents.map((agent) => f.rel(agent.path))
    expect(relPaths).toEqual([...relPaths].sort())
    expect(second.agents).toEqual(first.agents)
  })
})
