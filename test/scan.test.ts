import { afterEach, describe, expect, it } from "vitest"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, type ScanFixture } from "./support/scan-fixtures.ts"

const cleanups: Array<() => Promise<void>> = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("empty and unreadable locations", () => {
  it("returns a deterministic empty result for an empty location", async () => {
    const f = await fixture()

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toEqual([])
    expect(result.stats.directories).toBe(1)
    expect(result.stats.files).toBe(0)
    expect(result.stats.bytes).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toEqual([])
  })

  it("reports a missing location without throwing", async () => {
    const f = await fixture()

    const result = await scanSkills({ location: join(f.root, "missing") })

    expect(result.candidates).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("location-unreadable")
  })

  it("reports a regular file passed as the location", async () => {
    const f = await fixture()
    await f.write("README.md")

    const result = await scanSkills({ location: join(f.root, "README.md") })

    expect(result.candidates).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("location-unreadable")
  })

  it("measures elapsed time as a non-negative integer", async () => {
    const f = await fixture()

    const result = await scanSkills({ location: f.root })

    expect(Number.isInteger(result.stats.elapsedMs)).toBe(true)
    expect(result.stats.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

const ROOT_KINDS = [
  ["opencode-skills", ".opencode/skills"],
  ["opencode-skill", ".opencode/skill"],
  ["claude-skills", ".claude/skills"],
  ["agents-skills", ".agents/skills"],
] as const

describe("skill root enumeration", () => {
  for (const [kind, dir] of ROOT_KINDS) {
    it(`enumerates the ${kind} root with native glob eligibility`, async () => {
      const f = await fixture()
      await f.write(`A/${dir}/alpha.md`)
      await f.write(`A/${dir}/sub/SKILL.md`)
      await f.write(`A/${dir}/sub/notes.md`)
      await f.write(`A/${dir}/SKILL.md`)
      await f.write("A/README.md")
      await f.write("A/SKILL.md")
      await f.write("loose.md")

      const result = await scanSkills({ location: f.root })
      const found = result.candidates.map((candidate) => `${candidate.root}:${f.rel(candidate.path)}`)

      expect(found).toEqual(
        [`${kind}:A/${dir}/alpha.md`, `${kind}:A/${dir}/SKILL.md`, `${kind}:A/${dir}/sub/SKILL.md`].sort(),
      )
      expect(result.stats.files).toBe(3)
    })
  }

  it("reports the absolute path and its canonical form", async () => {
    const f = await fixture()
    const abs = await f.write("A/.opencode/skills/alpha.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toHaveLength(1)
    const [candidate] = result.candidates
    expect(candidate?.path).toBe(join(f.realRoot, "A/.opencode/skills/alpha.md"))
    expect(candidate?.path).toBe(abs.replace(f.root, f.realRoot))
    expect(candidate?.realPath).toBe(await realpath(candidate!.path))
  })
})

describe("markers and subproject attribution", () => {
  it("attributes a candidate to the location itself when the location carries the root", async () => {
    const f = await fixture()
    await f.write(".opencode/skills/x/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("")
    expect(result.candidates[0]?.markers).toEqual(["opencode-skills"])
  })

  it("attributes a candidate to its nearest marker-carrying ancestor", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/x/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates[0]?.subproject).toBe("A")
    expect(result.candidates[0]?.markers).toEqual(["opencode-skills"])
  })

  it("nests subprojects and never stops the walk at the first marker", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/z/SKILL.md")
    await f.write("A/A.1/CLAUDE.md")
    await f.write("A/A.1/.claude/skills/y/SKILL.md")

    const result = await scanSkills({ location: f.root })
    const found = result.candidates.map((candidate) => ({
      rel: f.rel(candidate.path),
      subproject: candidate.subproject,
      markers: candidate.markers,
    }))

    expect(found).toEqual([
      { rel: "A/.opencode/skills/z/SKILL.md", subproject: "A", markers: ["opencode-skills"] },
      {
        rel: "A/A.1/.claude/skills/y/SKILL.md",
        subproject: "A/A.1",
        markers: ["claude-skills", "claude-md"],
      },
    ])
    expect(result.candidates.map((candidate) => candidate.subproject)).toContain("A")
    expect(result.candidates.map((candidate) => candidate.subproject)).toContain("A/A.1")
  })

  it("treats .git as a marker whether it is a directory or a file", async () => {
    const f = await fixture()
    await f.mkdir("A/.git/objects")
    await f.write("A/.opencode/skills/x/SKILL.md")
    await f.write("B/.git", "gitdir: /tmp/elsewhere\n")
    await f.write("B/.opencode/skills/y/SKILL.md")

    const result = await scanSkills({ location: f.root })
    const bySubproject = new Map(result.candidates.map((c) => [c.subproject, c.markers]))

    expect(bySubproject.get("A")).toEqual(["opencode-skills", "git"])
    expect(bySubproject.get("B")).toEqual(["opencode-skills", "git"])
  })

  it("detects hg and agents-md markers", async () => {
    const f = await fixture()
    await f.mkdir("C/.hg/store")
    await f.write("C/.opencode/skills/z/SKILL.md")
    await f.write("D/AGENTS.md")
    await f.write("D/.opencode/skills/w/SKILL.md")

    const result = await scanSkills({ location: f.root })
    const bySubproject = new Map(result.candidates.map((c) => [c.subproject, c.markers]))

    expect(bySubproject.get("C")).toEqual(["opencode-skills", "hg"])
    expect(bySubproject.get("D")).toEqual(["opencode-skills", "agents-md"])
  })

  it("honours a replaced marker set when attributing candidates", async () => {
    const f = await fixture()
    await f.write("P/AGENTS.md")
    await f.write("P/Q/.opencode/skills/s.md")

    const replaced = await scanSkills({ location: f.root, markers: ["agents-md"] })
    const fallback = await scanSkills({ location: f.root })

    expect(replaced.candidates[0]?.subproject).toBe("P")
    expect(replaced.candidates[0]?.markers).toEqual(["agents-md"])
    expect(fallback.candidates[0]?.subproject).toBe("P/Q")
    expect(fallback.candidates[0]?.markers).toEqual(["opencode-skills"])
  })

  it("joins nested subproject segments with forward slashes", async () => {
    const f = await fixture()
    await f.write("one/two/three/CLAUDE.md")
    await f.write("one/two/three/.claude/skills/deep/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates[0]?.subproject).toBe("one/two/three")
    expect(result.candidates[0]?.subproject).not.toContain("\\")
  })
})

describe("depth boundary on subprojects", () => {
  it("discovers a depth-5 subproject whose skill file sits at depth 7", async () => {
    const f = await fixture()
    await f.write("L1/L2/L3/L4/L5/.opencode/skills/deep/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("L1/L2/L3/L4/L5")
    expect(result.candidates[0]?.markers).toEqual(["opencode-skills"])
  })

  it("hides a subproject that sits at depth 6", async () => {
    const f = await fixture()
    await f.write("L1/L2/L3/L4/L5/L6/.opencode/skills/six/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toEqual([])
  })

  it("moves the boundary with maxDepth", async () => {
    const f = await fixture()
    await f.write("L1/L2/L3/L4/.opencode/skills/four/SKILL.md")
    await f.write("L1/L2/L3/L4/L5/.opencode/skills/five/SKILL.md")

    const result = await scanSkills({ location: f.root, limits: { ...DEFAULT_SCAN_LIMITS, maxDepth: 4 } })

    expect(result.truncated).toBe(false)
    expect(result.candidates.map((candidate) => candidate.subproject).sort()).toEqual(["L1/L2/L3/L4"])
  })

  it("descent inside an open skill root is not depth-limited and visits the root once", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/a/b/c/d/e/f/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.stats.files).toBe(1)
    expect(result.stats.directories).toBe(9)
  })

  it("opens a skill root found at the depth boundary", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/a/b/SKILL.md")

    const result = await scanSkills({ location: f.root, limits: { ...DEFAULT_SCAN_LIMITS, maxDepth: 1 } })

    expect(result.truncated).toBe(false)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("A")
  })

  it("treats maxDepth 0 as the location only", async () => {
    const f = await fixture()
    await f.write(".opencode/skills/root.md")
    await f.write("A/.opencode/skills/x.md")

    const result = await scanSkills({ location: f.root, limits: { ...DEFAULT_SCAN_LIMITS, maxDepth: 0 } })

    expect(result.truncated).toBe(false)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("")
    expect(result.candidates[0]?.markers).toEqual(["opencode-skills"])
  })

  it("treats the location as a depth-0 subproject", async () => {
    const f = await fixture()
    await f.mkdir(".git/objects")
    await f.write(".opencode/skills/x/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("")
    expect(result.candidates[0]?.markers).toEqual(["opencode-skills", "git"])
  })
})
