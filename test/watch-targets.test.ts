import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import type { CommandCandidate, ScanCandidate, SkillRootKind } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { deriveWatchTargets } from "../src/watch.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: %NAME%\n---\n# %NAME%\n"

const candidate = (
  root: SkillRootKind,
  path: string,
  subproject: string,
): ScanCandidate => ({
  path,
  realPath: path,
  subproject,
  root,
  markers: [],
})

const relativeTargets = (root: string, targets: readonly string[]): readonly string[] =>
  targets.map((target) => relative(root, target).split(sep).join("/")).sort()

describe("watch target derivation", () => {
  it("derives one canonical, deduped target set from a multi-subproject scan", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC.replaceAll("%NAME%", "deploy"))
      await fixture.write("A/.opencode/skills/foo.md", "# Foo\n")
      await fixture.write("A/.claude/skills/foo.md", "# Foo\n")
      await fixture.write("A/A.1/.claude/skills/review/SKILL.md", DOC.replaceAll("%NAME%", "review"))
      await fixture.write("A/A.1/.claude/skills/foo.md", "# Foo\n")
      await fixture.write("B/.opencode/skill/lint/SKILL.md", DOC.replaceAll("%NAME%", "lint"))

      const scanned = await scanSkills({ location: fixture.root })
      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
      })

      // Six candidates: A owns three (deploy + two root-level docs), A/A.1 owns two, B owns one.
      expect(scanned.candidates).toHaveLength(6)
      expect(relativeTargets(fixture.realRoot, targets)).toEqual([
        "",
        "A",
        "A/.claude/skills",
        "A/.opencode/skills",
        "A/.opencode/skills/deploy",
        "A/A.1",
        "A/A.1/.claude/skills",
        "A/A.1/.claude/skills/review",
        "B",
        "B/.opencode/skill",
        "B/.opencode/skill/lint",
      ])
      expect(diagnostics).toEqual([])
      expect(targets.every((target) => target.startsWith(fixture.realRoot))).toBe(true)
      expect([...targets]).toEqual([...targets].sort())
      expect(new Set(targets).size).toBe(targets.length)
    } finally {
      await fixture.cleanup()
    }
  })

  it("yields only the location root when the scan found no candidates", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A")

      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [],
      })

      expect(targets).toEqual([fixture.realRoot])
      expect(diagnostics).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("drops a pruned directory and says why", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("node_modules/pkg/SKILL.md", "# Pkg\n")
      const path = join(fixture.realRoot, "node_modules/pkg/SKILL.md")

      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [candidate("opencode-skills", path, "")],
      })

      expect(targets).toEqual([fixture.realRoot])
      expect(diagnostics.some((entry) => entry.startsWith("watch-pruned:"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("drops a symlinked skill directory and says why", async () => {
    const fixture = await createRegistryFixture()
    const outside = await mkdtemp(join(tmpdir(), "nested-watch-link-"))

    try {
      await fixture.mkdirp("A/.opencode/skills")
      await symlink(outside, join(fixture.root, "A/.opencode/skills/linked"), "dir")
      const path = join(fixture.realRoot, "A/.opencode/skills/linked/SKILL.md")

      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [candidate("opencode-skills", path, "A")],
      })

      expect(targets).toEqual([fixture.realRoot, join(fixture.realRoot, "A"), join(fixture.realRoot, "A/.opencode/skills")].sort())
      expect(diagnostics.some((entry) => entry.startsWith("watch-symlink:"))).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  it("derives every command root, command directory, and subproject from one scan", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/command/deploy.md", "# Deploy\n")
      await fixture.write("A/.opencode/commands/release.md", "# Release\n")
      await fixture.write("B/.opencode/command/git/push.md", "# Push\n")

      const scanned = await scanSkills({ location: fixture.root })
      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
        commands: scanned.commands,
      })

      expect(scanned.commands).toHaveLength(3)
      expect(relativeTargets(fixture.realRoot, targets)).toEqual([
        "",
        "A",
        "A/.opencode/command",
        "A/.opencode/commands",
        "B",
        "B/.opencode/command",
        "B/.opencode/command/git",
      ])
      expect(diagnostics).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("falls back to the command file's own directory when its root pair is absent", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/commands-x/deploy.md", "# Deploy\n")
      const path = join(fixture.realRoot, "A/commands-x/deploy.md")
      const command: CommandCandidate = {
        name: "deploy",
        path,
        canonicalPath: path,
        subproject: "A",
        subprojectRealPath: join(fixture.realRoot, "A"),
        root: "opencode-command",
        markers: [],
      }

      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [],
        commands: [command],
      })

      expect(relativeTargets(fixture.realRoot, targets)).toEqual(["", "A", "A/commands-x"])
      expect(diagnostics).toEqual(["watch-root-unresolved: A/commands-x/deploy.md"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("derives the same command targets with and without a .git in either checkout", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("main/.git/worktrees/wt/keep", "")
      await fixture.write("wt/.git", "gitdir: ../main/.git/worktrees/wt\n")
      await fixture.write("main/.opencode/command/deploy.md", "# Deploy\n")
      await fixture.write("wt/.opencode/command/release.md", "# Release\n")

      const both = await scanSkills({ location: fixture.root })
      const withGit = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: both.candidates,
        commands: both.commands,
      })

      await rm(join(fixture.root, "main/.git"), { recursive: true, force: true })
      await rm(join(fixture.root, "wt/.git"), { force: true })
      const none = await scanSkills({ location: fixture.root })
      const withoutGit = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: none.candidates,
        commands: none.commands,
      })

      await fixture.mkdirp("main/.git")
      const one = await scanSkills({ location: fixture.root })
      const partially = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: one.candidates,
        commands: one.commands,
      })

      expect(relativeTargets(fixture.realRoot, withGit.targets)).toEqual([
        "",
        "main",
        "main/.opencode/command",
        "wt",
        "wt/.opencode/command",
      ])
      expect(withoutGit.targets).toEqual(withGit.targets)
      expect(partially.targets).toEqual(withGit.targets)
      expect(withGit.diagnostics).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("falls back to the candidate directory when its root segments do not resolve", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/skills/review/SKILL.md", "# Review\n")
      const path = join(fixture.realRoot, "A/skills/review/SKILL.md")

      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [candidate("claude-skills", path, "A")],
      })

      expect(relativeTargets(fixture.realRoot, targets)).toEqual([
        "",
        "A",
        "A/skills/review",
      ])
      expect(diagnostics).toEqual([`watch-root-unresolved: A/skills/review/SKILL.md`])
    } finally {
      await fixture.cleanup()
    }
  })
})
