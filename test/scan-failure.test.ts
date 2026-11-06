import { afterEach, describe, expect, it } from "vitest"
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

// A chmod-only refusal cannot be provoked when the process already bypasses the mode bits.
const asRoot = process.getuid?.() === 0

describe("filesystem failures", () => {
  it.skipIf(asRoot)("reports an unreadable directory and still returns its siblings", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/visible.md")
    await f.write("A/.opencode/skills/locked/hidden.md")
    await f.chmod("A/.opencode/skills/locked", 0o000)

    const result = await scanSkills({ location: f.root })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A/.opencode/skills/visible.md",
    ])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("unreadable-directory")
    expect(result.diagnostics[0]).toContain("A/.opencode/skills/locked")
    expect(result.truncated).toBe(false)
  })

  it.skipIf(asRoot)("reports both the unreadable directory and a budget stop", async () => {
    const f = await fixture()
    await f.write(".opencode/skills/locked/hidden.md")
    await f.chmod(".opencode/skills/locked", 0o000)
    await f.write("Z/.opencode/skills/z.md")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxDirectories: 4 },
    })

    expect(result.candidates).toEqual([])
    expect(result.truncated).toBe(true)
    expect(result.diagnostics.some((line) => line.includes("unreadable-directory"))).toBe(true)
    expect(result.diagnostics.some((line) => line.includes("budget-directories"))).toBe(true)
  })

  it("caps the diagnostic list at 200 entries plus one summary", async () => {
    const f = await fixture()
    for (let index = 0; index < 205; index += 1) {
      await f.symlink(
        `.opencode/skills/broken-${String(index).padStart(3, "0")}.md`,
        join(f.root, "missing", `${index}.md`),
      )
    }

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toHaveLength(201)
    expect(result.diagnostics.slice(0, 200).every((line) => line.includes("file-symlink-broken"))).toBe(true)
    expect(result.diagnostics[200]).toContain("diagnostics-truncated")
  })
})
