import { dirname, join, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { nativeAgentRootCandidates, resolveNativeAgentRoots } from "../src/native.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

/**
 * F15 Step 4 (ADR agent A5): the native agent roots the scan must not re-publish —
 * `<ancestor>/.opencode/{agent,agents}` for every ancestor of the location plus
 * `<config directory>/{agent,agents}`. `.claude` and `.agents` are never in that set.
 */

const AGENT_DIRECTORIES = ["agent", "agents"]

function ancestorsOf(location: string): readonly string[] {
  const ancestors: string[] = []
  let current = location
  for (;;) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) return ancestors
    current = parent
  }
}

describe("native agent root candidates", () => {
  it("covers every ancestor .opencode and the config directory, and nothing under .claude or .agents", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A/A.1")
      const location = join(fixture.root, "A/A.1")
      const configDirectory = join(fixture.root, "home/.config/opencode")
      const expected = new Set(
        [configDirectory, ...ancestorsOf(location).map((directory) => join(directory, ".opencode"))].flatMap(
          (directory) => AGENT_DIRECTORIES.map((leaf) => join(directory, leaf)),
        ),
      )

      const candidates = nativeAgentRootCandidates({ location, home: join(fixture.root, "home"), configDirectory })

      expect(new Set(candidates)).toEqual(expected)
      expect(candidates).toHaveLength(expected.size)
      expect(candidates).toContain(join("/", ".opencode", "agent"))
      for (const candidate of candidates) {
        const segments = candidate.split(sep).filter((segment) => segment !== "")
        expect(segments).not.toContain(".claude")
        expect(segments).not.toContain(".agents")
      }
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("resolved native agent roots", () => {
  it("canonicalises, sorts and dedupes the existing roots", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp(".opencode/agent")
      await fixture.mkdirp(".opencode/agents")
      await fixture.mkdirp(".claude/agent")
      await fixture.mkdirp(".agents/agents")
      const missing = join(fixture.root, "missing")

      const resolved = await resolveNativeAgentRoots({
        location: fixture.root,
        home: missing,
        configDirectory: missing,
      })

      expect(resolved).toEqual(
        [
          join(fixture.realRoot, ".opencode", "agent"),
          join(fixture.realRoot, ".opencode", "agents"),
        ].sort(),
      )
      expect(new Set(resolved).size).toBe(resolved.length)
    } finally {
      await fixture.cleanup()
    }
  })

  it("skips roots that do not exist", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A/.opencode/agent")
      const missing = join(fixture.root, "missing")

      const resolved = await resolveNativeAgentRoots({
        location: join(fixture.root, "A/A.1"),
        home: missing,
        configDirectory: missing,
      })

      expect(resolved).toEqual([join(fixture.realRoot, "A", ".opencode", "agent")])
    } finally {
      await fixture.cleanup()
    }
  })

  it("lists a config directory that is also an ancestor .opencode once", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp(".opencode/agent")

      const resolved = await resolveNativeAgentRoots({
        location: fixture.root,
        home: join(fixture.root, "empty-home"),
        configDirectory: join(fixture.root, ".opencode"),
      })

      expect(resolved).toEqual([join(fixture.realRoot, ".opencode", "agent")])
    } finally {
      await fixture.cleanup()
    }
  })

  it("honours a config directory override", async () => {
    const configs = await createRegistryFixture()
    const location = await createRegistryFixture()

    try {
      await configs.mkdirp("opencode/agents")

      const resolved = await resolveNativeAgentRoots({
        location: location.root,
        home: join(configs.root, "home"),
        configDirectory: join(configs.root, "opencode"),
      })

      expect(resolved).toEqual([await configs.realpathOf("opencode/agents")])
    } finally {
      await configs.cleanup()
      await location.cleanup()
    }
  })
})
