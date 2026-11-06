import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
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
