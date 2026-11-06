import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import { PRUNE_DIRECTORIES } from "../src/contracts.ts"
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

describe("prune rules", () => {
  it("never descends into any default pruned directory", async () => {
    const f = await fixture()
    for (const name of PRUNE_DIRECTORIES) {
      await f.write(`A/${name}/deep/.opencode/skills/s.md`)
    }
    await f.write("keep/.opencode/skills/k.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual(["keep/.opencode/skills/k.md"])
    expect(result.diagnostics).toEqual([])
  })

  it("still detects a marker inside a pruned directory", async () => {
    const f = await fixture()
    await f.mkdir("A/.git/objects")
    await f.write("A/.opencode/skills/a.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("A")
    expect(result.candidates[0]?.markers).toEqual(["opencode-skills", "git"])
  })

  it("replaces the default prune list wholesale", async () => {
    const f = await fixture()
    await f.write("node_modules/.opencode/skills/n.md")
    await f.write("skipme/.opencode/skills/s.md")

    const replaced = await scanSkills({ location: f.root, prune: ["skipme"] })
    const defaults = await scanSkills({ location: f.root })

    expect(replaced.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "node_modules/.opencode/skills/n.md",
    ])
    expect(defaults.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "skipme/.opencode/skills/s.md",
    ])
  })

  it("never prunes the location itself", async () => {
    const f = await fixture()
    await f.write("dist/.opencode/skills/d.md")

    const result = await scanSkills({ location: join(f.root, "dist") })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("")
  })

  it("prunes inside an open skill root at any depth", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/node_modules/pkg/readme.md")
    await f.write("A/.opencode/skills/node_modules/pkg/SKILL.md")
    await f.write("A/.opencode/skills/keep/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A/.opencode/skills/keep/SKILL.md",
    ])
  })
})
