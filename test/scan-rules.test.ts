import { afterEach, describe, expect, it } from "vitest"
import { realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PRUNE_DIRECTORIES } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, createOutside, type ScanFixture } from "./support/scan-fixtures.ts"

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

describe("symlink policy", () => {
  it("follows an in-location file symlink and reports both paths", async () => {
    const f = await fixture()
    const target = await f.write("shared/real.md")
    await f.symlink("A/.opencode/skills/linked.md", target)

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.path).toBe(join(f.realRoot, "A/.opencode/skills/linked.md"))
    expect(result.candidates[0]?.realPath).toBe(await realpath(target))
  })

  it("skips a file symlink whose target leaves the location", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    await f.symlink("A/.opencode/skills/linked.md", await outside.write("real.md"))

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toEqual([])
    expect(result.diagnostics.filter((line) => line.includes("file-symlink-outside"))).toHaveLength(1)
  })

  it("never follows a directory symlink", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    await outside.write("dir/.opencode/skills/x/SKILL.md")
    await f.symlink("A/link", join(outside.root, "dir"))

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toEqual([])
    expect(result.diagnostics.filter((line) => line.includes("directory-symlink"))).toHaveLength(1)
  })

  it("reports a broken file symlink without throwing", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/keep.md")
    await f.symlink("A/.opencode/skills/broken.md", join(f.root, "missing.md"))

    const result = await scanSkills({ location: f.root })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A/.opencode/skills/keep.md",
    ])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("file-symlink-broken")
  })

  it("rejects a target that is only a string prefix of the location", async () => {
    const f = await fixture()
    const sibling = await f.siblings("-sibling")
    await writeFile(join(sibling, "real.md"), "outside\n")
    await f.symlink("A/.opencode/skills/sib.md", join(sibling, "real.md"))

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toEqual([])
    expect(result.diagnostics.filter((line) => line.includes("file-symlink-outside"))).toHaveLength(1)
  })
})

describe("excludeRoots", () => {
  it("prunes an excluded subtree and keeps its siblings", async () => {
    const f = await fixture()
    await f.write(".opencode/skills/at-location.md")
    await f.write("A/.opencode/skills/a.md")
    await f.write("B/.opencode/skills/b.md")

    const result = await scanSkills({ location: f.root, excludeRoots: [join(f.realRoot, "A")] })

    expect(result.candidates.map((candidate) => f.rel(candidate.path)).sort()).toEqual([
      ".opencode/skills/at-location.md",
      "B/.opencode/skills/b.md",
    ])
    expect(result.diagnostics).toEqual([])
  })

  it("does not exclude a directory that merely shares a string prefix", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/a.md")
    await f.write("A-extra/.opencode/skills/extra.md")

    const result = await scanSkills({ location: f.root, excludeRoots: [join(f.realRoot, "A")] })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A-extra/.opencode/skills/extra.md",
    ])
  })

  it("tolerates an entry that cannot be resolved", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/a.md")

    const result = await scanSkills({
      location: f.root,
      excludeRoots: [join(f.realRoot, "does-not-exist")],
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.diagnostics).toEqual([])
  })

  it("changes nothing when the exclude list is empty", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/a.md")

    const excluded = await scanSkills({ location: f.root, excludeRoots: [] })
    const plain = await scanSkills({ location: f.root })

    expect(excluded.candidates).toEqual(plain.candidates)
  })

  it("applies inside an open skill root", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/keep/SKILL.md")
    await f.write("A/.opencode/skills/drop/SKILL.md")

    const result = await scanSkills({
      location: f.root,
      excludeRoots: [join(f.realRoot, "A/.opencode/skills/drop")],
    })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A/.opencode/skills/keep/SKILL.md",
    ])
  })
})

const LINKED_ROOTS = [
  ["opencode-skills", ".opencode/skills"],
  ["opencode-skill", ".opencode/skill"],
  ["claude-skills", ".claude/skills"],
  ["agents-skills", ".agents/skills"],
] as const

describe("symlinked skill roots", () => {
  for (const [kind, dir] of LINKED_ROOTS) {
    it(`refuses a ${kind} root that links outside the location`, async () => {
      const f = await fixture()
      const outside = await createOutside()
      cleanups.push(() => outside.cleanup())
      await outside.write("skills/SKILL.md")
      await outside.write("skills/x.md")
      await f.symlink(`A/${dir}`, join(outside.root, "skills"))

      const result = await scanSkills({ location: f.root })

      expect(result.candidates).toEqual([])
      expect(result.diagnostics).toEqual([`directory-symlink: A/${dir}`])
    })

    it(`refuses a ${kind} root that links inside the location`, async () => {
      const f = await fixture()
      await f.write("shared/real-root/SKILL.md")
      await f.write("shared/real-root/x.md")
      await f.symlink(`A/${dir}`, join(f.root, "shared/real-root"))

      const result = await scanSkills({ location: f.root })

      expect(result.candidates).toEqual([])
      expect(result.diagnostics).toEqual([`directory-symlink: A/${dir}`])
      expect(
        result.candidates.every(
          (candidate) =>
            candidate.realPath === f.realRoot || candidate.realPath.startsWith(`${f.realRoot}/`),
        ),
      ).toBe(true)
    })
  }

  it("never marks a directory through a refused root", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    await outside.write("skills/SKILL.md")
    await f.symlink("A/.opencode/skills", join(outside.root, "skills"))
    await f.write("A/.claude/skills/deep/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.markers).toEqual(["claude-skills"])
    expect(result.candidates[0]?.subproject).toBe("A")
  })
})

describe("excludeRoots on an opened root", () => {
  it("honours an excluded skill root instead of scanning it", async () => {
    const f = await fixture()
    await f.write(".opencode/skills/at-location.md")

    const result = await scanSkills({
      location: f.root,
      excludeRoots: [join(f.realRoot, ".opencode/skills")],
    })

    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toEqual([])
  })
})
