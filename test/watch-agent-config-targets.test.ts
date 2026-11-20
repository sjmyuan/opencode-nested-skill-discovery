import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import type { AgentConfigCandidate } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { deriveWatchTargets } from "../src/watch.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

/**
 * F16 Step 8 (C6 config branch, A13): editing a config document refreshes within the
 * debounce, and a config-only subproject enters the watch set through the document's
 * parent. There is no config root kind, so no `watch-root-unresolved:` can name one.
 */

const relativeTargets = (root: string, targets: readonly string[]): readonly string[] =>
  targets.map((target) => relative(root, target).split(sep).join("/")).sort()

const configCandidate = (overrides: Partial<AgentConfigCandidate> = {}): AgentConfigCandidate => ({
  path: "",
  canonicalPath: "",
  subproject: "A",
  subprojectRealPath: "A",
  markers: [],
  document: "opencode.json",
  ...overrides,
})

describe("config document watch targets", () => {
  it("watches both documents' parents and the subproject", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/opencode.json", "{}\n")
      await fixture.write("A/.opencode/opencode.jsonc", "{}\n")

      const scanned = await scanSkills({ location: fixture.root })
      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
        agentConfigs: scanned.agentConfigs,
      })

      expect(scanned.agentConfigs).toHaveLength(2)
      expect(relativeTargets(fixture.realRoot, targets)).toEqual(["", "A", "A/.opencode"])
      expect(diagnostics).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("watches a config-only subproject that no other candidate names", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/opencode.json", "{}\n")
      const scanned = await scanSkills({ location: fixture.root })
      const { targets } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [],
        commands: [],
        agents: [],
        agentConfigs: scanned.agentConfigs,
      })

      expect(relativeTargets(fixture.realRoot, targets)).toEqual(["", "A"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps the derived set byte-identical when agentConfigs are omitted", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/opencode.json", "{}\n")
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", "# Deploy\n")

      const scanned = await scanSkills({ location: fixture.root })
      const withoutConfigs = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
        commands: scanned.commands,
        agents: scanned.agents,
      })

      expect(relativeTargets(fixture.realRoot, withoutConfigs.targets)).toEqual([
        "",
        "A",
        "A/.opencode/skills",
        "A/.opencode/skills/deploy",
      ])
      expect(withoutConfigs.diagnostics).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports watch-unavailable instead of throwing when the parent is gone", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A")
      const path = join(fixture.realRoot, "A/gone/opencode.json")

      const { targets, diagnostics } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: [],
        agentConfigs: [configCandidate({ path, canonicalPath: path, subproject: "A/gone" })],
      })

      expect(relativeTargets(fixture.realRoot, targets)).toEqual([""])
      expect(diagnostics).toEqual(["watch-unavailable: A/gone: ENOENT"])
    } finally {
      await fixture.cleanup()
    }
  })

  it("watches a nested subproject's document alongside its ancestor", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/A.1/opencode.json", "{}\n")
      await fixture.write("A/.opencode/agent/x.md", "# X\n")

      const scanned = await scanSkills({ location: fixture.root })
      const { targets } = await deriveWatchTargets({
        location: fixture.realRoot,
        candidates: scanned.candidates,
        agents: scanned.agents,
        agentConfigs: scanned.agentConfigs,
      })

      expect(relativeTargets(fixture.realRoot, targets)).toEqual(["", "A", "A/.opencode/agent", "A/A.1"])
    } finally {
      await fixture.cleanup()
    }
  })
})
