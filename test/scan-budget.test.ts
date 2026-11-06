import { afterEach, describe, expect, it } from "vitest"
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

/** Twelve visited directories: the location, five subprojects and their skill roots. */
async function wideFixture(): Promise<ScanFixture> {
  const f = await fixture()
  await f.write(".opencode/skills/z.md")
  for (const name of ["A", "B", "C", "D", "E"]) {
    await f.write(`${name}/.opencode/skills/${name}.md`)
  }
  return f
}

describe("directory budget", () => {
  it("stops the walk at maxDirectories and reports it", async () => {
    const f = await wideFixture()
    const limits = { ...DEFAULT_SCAN_LIMITS, maxDirectories: 3 }

    const limited = await scanSkills({ location: f.root, limits })
    const again = await scanSkills({ location: f.root, limits })
    const full = await scanSkills({ location: f.root })

    expect(limited.stats.directories).toBe(3)
    expect(limited.truncated).toBe(true)
    expect(limited.diagnostics).toHaveLength(1)
    expect(limited.diagnostics[0]).toContain("maxDirectories")
    expect(limited.diagnostics[0]).toContain("3")
    expect(full.truncated).toBe(false)
    expect(full.candidates).toHaveLength(6)

    const limitedPaths = limited.candidates.map((candidate) => candidate.path)
    const fullPaths = new Set(full.candidates.map((candidate) => candidate.path))
    expect(limitedPaths.every((path) => fullPaths.has(path))).toBe(true)
    expect(again.candidates).toEqual(limited.candidates)
    expect(again.diagnostics).toEqual(limited.diagnostics)
  })

  it("returns nothing when maxDirectories is zero", async () => {
    const f = await wideFixture()

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxDirectories: 0 },
    })

    expect(result.candidates).toEqual([])
    expect(result.stats.directories).toBe(0)
    expect(result.truncated).toBe(true)
  })

  it("does not truncate an unbudgeted run", async () => {
    const f = await wideFixture()

    const result = await scanSkills({ location: f.root })

    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(6)
  })
})

describe("file budget", () => {
  async function threeCandidates(): Promise<ScanFixture> {
    const f = await fixture()
    await f.write("A/.opencode/skills/a.md")
    await f.write("B/.opencode/skills/b.md")
    await f.write("C/.opencode/skills/c.md")
    return f
  }

  it("stops collecting candidates at maxFiles and reports it", async () => {
    const f = await threeCandidates()
    const limits = { ...DEFAULT_SCAN_LIMITS, maxFiles: 2 }

    const limited = await scanSkills({ location: f.root, limits })
    const again = await scanSkills({ location: f.root, limits })

    expect(limited.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A/.opencode/skills/a.md",
      "B/.opencode/skills/b.md",
    ])
    expect(limited.stats.files).toBe(2)
    expect(limited.truncated).toBe(true)
    expect(limited.diagnostics).toHaveLength(1)
    expect(limited.diagnostics[0]).toContain("maxFiles")
    expect(limited.diagnostics[0]).toContain("2")
    expect(again.candidates).toEqual(limited.candidates)
  })

  it("honours a budget of one file", async () => {
    const f = await threeCandidates()

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFiles: 1 },
    })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A/.opencode/skills/a.md",
    ])
    expect(result.truncated).toBe(true)
  })

  it("keeps every candidate under the default budget", async () => {
    const f = await threeCandidates()

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toHaveLength(3)
    expect(result.truncated).toBe(false)
  })
})

describe("per-file byte budget", () => {
  it("excludes an oversized candidate and reports it", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/big/SKILL.md", "x".repeat(50))

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFileBytes: 10 },
    })

    expect(result.candidates).toEqual([])
    expect(result.truncated).toBe(true)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("A/.opencode/skills/big/SKILL.md")
    expect(result.diagnostics[0]).toContain("10")
  })

  it("accepts a candidate inside the per-file budget and sums its size", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/small.md", "12345")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFileBytes: 10 },
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.stats.bytes).toBe(5)
    expect(result.truncated).toBe(false)
  })

  it("stats without reading content, so an unreadable file is still a candidate", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/locked.md", "123456789012")
    await f.chmod("A/.opencode/skills/locked.md", 0o000)

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toHaveLength(1)
    expect(result.stats.bytes).toBe(12)
    expect(result.diagnostics).toEqual([])
  })
})
