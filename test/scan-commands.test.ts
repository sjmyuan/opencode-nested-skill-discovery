import { afterEach, describe, expect, it } from "vitest"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
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

/** D3: diagnostics keep the frozen grammar and never leak an absolute path. */
function expectFrozenGrammar(diagnostics: readonly string[], roots: readonly string[]): void {
  for (const line of diagnostics) {
    expect(line).toMatch(/^[a-z-]+: /)
    for (const root of roots) expect(line).not.toContain(root)
  }
}

describe("command name derivation", () => {
  it("derives a root-level name from command/deploy.md", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/deploy.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toHaveLength(1)
    const [command] = result.commands
    expect(command).toMatchObject({
      name: "deploy",
      path: join(f.realRoot, "A/.opencode/command/deploy.md"),
      canonicalPath: await realpath(join(f.root, "A/.opencode/command/deploy.md")),
      subproject: "A",
      subprojectRealPath: await realpath(join(f.root, "A")),
      root: "opencode-command",
      markers: ["opencode-command"],
    })
    expect(command?.name).not.toContain(".md")
  })

  it("derives a nested name with POSIX separators from commands/review/pr.md", async () => {
    const f = await fixture()
    await f.write("A/.opencode/commands/review/pr.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]?.name).toBe("review/pr")
    expect(result.commands[0]?.root).toBe("opencode-commands")
    expect(result.commands[0]?.name).not.toContain("\\")
  })

  it("discovers both command roots in one subproject", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/a.md")
    await f.write("A/.opencode/commands/b/c.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => `${command.root}:${command.name}`)).toEqual([
      "opencode-command:a",
      "opencode-commands:b/c",
    ])
  })

  it("keeps dot files and dot directories", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/.draft.md")
    await f.write("A/.opencode/command/.archive/old.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => command.name)).toEqual([".archive/old", ".draft"])
  })
})

describe("command subproject attribution", () => {
  it("attributes a command to the nearest marked subproject", async () => {
    const f = await fixture()
    await f.write("A/AGENTS.md")
    await f.write("A/team/.opencode/command/one.md")
    await f.write("A/team/deep/CLAUDE.md")
    await f.write("A/team/deep/.opencode/command/two.md")

    const result = await scanSkills({ location: f.root })
    const found = result.commands.map((command) => ({
      name: command.name,
      subproject: command.subproject,
      subprojectRealPath: f.rel(command.subprojectRealPath),
      markers: command.markers,
    }))

    expect(found).toEqual([
      {
        name: "one",
        subproject: "A/team",
        subprojectRealPath: "A/team",
        markers: ["opencode-command"],
      },
      {
        name: "two",
        subproject: "A/team/deep",
        subprojectRealPath: "A/team/deep",
        markers: ["opencode-command", "claude-md"],
      },
    ])
  })

  it("treats a command-only directory as a subproject", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/x.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]?.subproject).toBe("A")
    expect(result.commands[0]?.markers).toEqual(["opencode-command"])
    expect(result.commands[0]?.subprojectRealPath).toBe(await realpath(join(f.root, "A")))
  })
})

describe("command scope", () => {
  it("excludes the location's own command roots", async () => {
    const f = await fixture()
    await f.write(".opencode/command/root.md")
    await f.write(".opencode/commands/root2.md")
    await f.write("A/.opencode/command/nested.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => command.name)).toEqual(["nested"])
    expect(result.commands[0]?.subproject).toBe("A")
    expect(result.diagnostics).toEqual([])
  })

  it("caps subproject depth at five and never caps depth inside a command root", async () => {
    const f = await fixture()
    await f.write("L1/L2/L3/L4/L5/.opencode/command/deep/deeper/deepest/x.md")
    await f.write("L1/L2/L3/L4/L5/L6/.opencode/command/six.md")

    const result = await scanSkills({ location: f.root })

    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toEqual([])
    expect(result.commands.map((command) => `${command.subproject}:${command.name}`)).toEqual([
      "L1/L2/L3/L4/L5:deep/deeper/deepest/x",
    ])
  })

  it("prunes default directories inside a command root", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/node_modules/pkg/x.md")
    await f.write("A/.opencode/command/keep.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => command.name)).toEqual(["keep"])
    expect(result.diagnostics).toEqual([])
  })
})

describe("command containment", () => {
  it("follows an in-location file symlink and reports both paths", async () => {
    const f = await fixture()
    const target = await f.write("shared/real.md")
    await f.symlink("A/.opencode/command/linked.md", target)

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]?.name).toBe("linked")
    expect(result.commands[0]?.path).toBe(join(f.realRoot, "A/.opencode/command/linked.md"))
    expect(result.commands[0]?.canonicalPath).toBe(await realpath(target))
  })

  it("skips a file symlink leaving the location", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    await f.symlink("A/.opencode/command/outside.md", await outside.write("real.md"))

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toEqual([])
    expect(result.diagnostics.filter((line) => line.includes("file-symlink-outside"))).toHaveLength(1)
    expectFrozenGrammar(result.diagnostics, [f.root, f.realRoot, outside.root, outside.realRoot])
  })

  it("never follows a directory symlink inside a command root", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    await outside.write("pkg/x.md")
    await f.write("A/.opencode/command/keep.md")
    await f.symlink("A/.opencode/command/pkg", join(outside.root, "pkg"))

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => command.name)).toEqual(["keep"])
    expect(result.diagnostics).toEqual(["directory-symlink: A/.opencode/command/pkg"])
    expectFrozenGrammar(result.diagnostics, [f.root, f.realRoot, outside.root, outside.realRoot])
  })

  it("refuses a symlinked command root and does not re-walk it", async () => {
    const f = await fixture()
    await f.write("A/.opencode/real-command/x.md")
    await f.write("A/.opencode/commands/keep.md")
    await f.symlink("A/.opencode/command", join(f.root, "A/.opencode/real-command"))

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => command.name)).toEqual(["keep"])
    expect(result.diagnostics).toEqual(["directory-symlink: A/.opencode/command"])
    expectFrozenGrammar(result.diagnostics, [f.root, f.realRoot])
  })
})

describe("command budgets", () => {
  it("skips an oversized command file with a diagnostic", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/big.md", "x".repeat(50))
    await f.write("A/.opencode/command/small.md", "12345")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFileBytes: 10 },
    })

    expect(result.commands.map((command) => command.name)).toEqual(["small"])
    expect(result.truncated).toBe(true)
    expect(result.stats.bytes).toBe(5)
    expect(result.diagnostics).toEqual([
      "budget-file-bytes: A/.opencode/command/big.md size=50 maxFileBytes=10",
    ])
    expectFrozenGrammar(result.diagnostics, [f.root, f.realRoot])
  })

  it("counts command files against the file budget", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/a.md")
    await f.write("A/.opencode/command/b.md")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFiles: 1 },
    })

    expect(result.commands.map((command) => command.name)).toEqual(["a"])
    expect(result.stats.files).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.diagnostics).toEqual(["budget-files: maxFiles=1"])
    expectFrozenGrammar(result.diagnostics, [f.root, f.realRoot])
  })
})

describe("command isolation and order", () => {
  it("keeps command files out of the skill candidate list", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/deploy/SKILL.md")
    await f.write("A/.opencode/command/deploy.md")
    await f.write("B/.opencode/commands/review/pr.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates.map((candidate) => f.rel(candidate.path))).toEqual([
      "A/.opencode/skills/deploy/SKILL.md",
    ])
    expect(result.commands.map((command) => `${command.subproject}:${command.name}`)).toEqual([
      "A:deploy",
      "B:review/pr",
    ])
  })

  it("sorts command candidates by canonical path then path", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/a.md")
    await f.write("A/.opencode/command/a/x.md")
    const target = await f.write("shared/real.md")
    await f.symlink("A/.opencode/command/l1.md", target)
    await f.symlink("A/.opencode/command/l2.md", target)

    const result = await scanSkills({ location: f.root })

    // Read order would put a/x.md before a.md and the two link names in path order.
    expect(result.commands.map((command) => command.name)).toEqual(["a", "a/x", "l1", "l2"])
    const canonical = result.commands.map((command) => command.canonicalPath)
    expect(canonical).toEqual([...canonical].sort())
    expect(result.commands[2]?.canonicalPath).toBe(result.commands[3]?.canonicalPath)
    expect(result.commands[2]?.path < result.commands[3]!.path).toBe(true)
  })
})
