import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import type { AgentCandidate } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { deriveWatchTargets } from "../src/watch.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

/**
 * F15 Step 6 (ADR agent A13): the watcher set covers an agent root, its subproject and the
 * candidate's own directory — the command rule with an agent kind table. `agents` is
 * optional so every pre-change caller derives exactly what it derived before.
 */

const relativeTargets = (root: string, targets: readonly string[]): readonly string[] =>
  targets.map((target) => relative(root, target).split(sep).join("/")).sort()

const agentCandidate = (overrides: Partial<AgentCandidate> = {}): AgentCandidate => ({
  name: "translator",
  path: "",
  canonicalPath: "",
  subproject: "A",
  subprojectRealPath: "A",
  root: "opencode-agent",
  markers: [],
  ...overrides,
})

describe("agent watch targets", () => {
  it("derives the subproject, both agent roots and the candidate directories", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/agent/translator.md", "# Translator\n")
      await fixture.write("A/.opencode/agents/team/pr.md", "# PR\n")

      const scanned = await scanSkills({ location: fixture.root })
      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
        agents: scanned.agents,
      })

      expect(scanned.agents).toHaveLength(2)
      expect(relativeTargets(fixture.realRoot, targets)).toEqual([
        "",
        "A",
        "A/.opencode/agent",
        "A/.opencode/agents",
        "A/.opencode/agents/team",
      ])
      expect(diagnostics).toEqual([])
      expect(new Set(targets).size).toBe(targets.length)
    } finally {
      await fixture.cleanup()
    }
  })

  it("watches an agent-only subproject that no other candidate names", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/agent/translator.md", "# Translator\n")

      const scanned = await scanSkills({ location: fixture.root })
      const { targets } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [],
        commands: [],
        agents: scanned.agents,
      })

      expect(relativeTargets(fixture.realRoot, targets)).toEqual(["", "A", "A/.opencode/agent"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the derived set byte-identical when agents are omitted", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", "# Deploy\n")
      await fixture.write("A/.opencode/command/deploy.md", "# Deploy\n")
      await fixture.write("A/.opencode/agent/translator.md", "# Translator\n")

      const scanned = await scanSkills({ location: fixture.root })
      const withoutAgents = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
        commands: scanned.commands,
      })

      expect(relativeTargets(fixture.realRoot, withoutAgents.targets)).toEqual([
        "",
        "A",
        "A/.opencode/command",
        "A/.opencode/skills",
        "A/.opencode/skills/deploy",
      ])
      expect(withoutAgents.diagnostics).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports one unresolved root and keeps the rest of the set", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A/agent-x")
      const path = join(fixture.realRoot, "A/agent-x/translator.md")

      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [],
        agents: [agentCandidate({ path, canonicalPath: path })],
      })

      expect(relativeTargets(fixture.realRoot, targets)).toEqual(["", "A", "A/agent-x"])
      expect(diagnostics).toEqual(["watch-root-unresolved: A/agent-x/translator.md"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps every agent target inside the location root", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/agent/translator.md", "# Translator\n")
      const scanned = await scanSkills({ location: fixture.root })
      const { targets } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
        agents: scanned.agents,
      })

      expect(targets.every((target) => target.startsWith(fixture.realRoot))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })
})
