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
