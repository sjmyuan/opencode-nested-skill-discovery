import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { nativeRootCandidates, resolveNativeRoots } from "../src/native.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const CONFIG_DIRECTORIES = [".opencode", ".claude", ".agents"]
const SKILL_DIRECTORIES = ["skill", "skills"]

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

describe("native root candidates", () => {
  it("covers every ancestor and the three global directories", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A/A.1")
      const location = join(fixture.root, "A/A.1")
      const home = join(fixture.root, "home")
      const configDirectory = join(fixture.root, "home/.config/opencode")
      const ancestors = ancestorsOf(location)
      const scoped = ancestors.flatMap((directory) =>
        CONFIG_DIRECTORIES.map((name) => join(directory, name)),
      )
      const global = [configDirectory, join(home, ".claude"), join(home, ".agents")]
      const expected = new Set(
        [...scoped, ...global].flatMap((directory) =>
          SKILL_DIRECTORIES.map((leaf) => join(directory, leaf)),
        ),
      )

      const candidates = nativeRootCandidates({ location, home, configDirectory })

      expect(new Set(candidates)).toEqual(expected)
      expect(candidates).toHaveLength(expected.size)
      expect(ancestors).toContain("/")
      expect(candidates).toContain(join("/", ".opencode", "skills"))
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("resolved native roots", () => {
  it("canonicalises, sorts, and dedupes the existing roots", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp(".opencode/skills")
      await fixture.mkdirp(".claude/skill")
      await fixture.mkdirp(".agents/skills")
      const missing = join(fixture.root, "missing")

      const resolved = await resolveNativeRoots({
        location: fixture.root,
        home: missing,
        configDirectory: missing,
      })

      expect(resolved).toEqual(
        [
          join(fixture.realRoot, ".agents", "skills"),
          join(fixture.realRoot, ".claude", "skill"),
          join(fixture.realRoot, ".opencode", "skills"),
        ].sort(),
      )
      expect(new Set(resolved).size).toBe(resolved.length)
    } finally {
      await fixture.cleanup()
    }
  })

  it("skips a missing config directory under an ancestor", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A/.opencode/skills")
      const missing = join(fixture.root, "missing")

      const resolved = await resolveNativeRoots({
        location: join(fixture.root, "A/A.1"),
        home: missing,
        configDirectory: missing,
      })

      expect(resolved).toEqual([join(fixture.realRoot, "A", ".opencode", "skills")])
    } finally {
      await fixture.cleanup()
    }
  })

  it("lists a config directory that is also an ancestor once", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp(".claude/skills")

      const resolved = await resolveNativeRoots({
        location: fixture.root,
        home: join(fixture.root, "empty-home"),
        configDirectory: join(fixture.root, ".claude"),
      })

      expect(resolved).toEqual([join(fixture.realRoot, ".claude", "skills")])
    } finally {
      await fixture.cleanup()
    }
  })

  it("honours a config directory override", async () => {
    const configs = await createRegistryFixture()
    const location = await createRegistryFixture()

    try {
      await configs.mkdirp("opencode/skills")
      await configs.mkdirp("other/skills")

      const resolved = await resolveNativeRoots({
        location: location.root,
        home: join(configs.root, "home"),
        configDirectory: join(configs.root, "opencode"),
      })

      expect(resolved).toEqual([await configs.realpathOf("opencode/skills")])
    } finally {
      await configs.cleanup()
      await location.cleanup()
    }
  })

  it("returns only the two roots that exist", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp(".opencode/skills")
      await fixture.mkdirp(".agents/skills")
      const missing = join(fixture.root, "missing")

      const resolved = await resolveNativeRoots({
        location: fixture.root,
        home: missing,
        configDirectory: missing,
      })

      expect(resolved).toEqual([
        join(fixture.realRoot, ".agents", "skills"),
        join(fixture.realRoot, ".opencode", "skills"),
      ])
    } finally {
      await fixture.cleanup()
    }
  })
})
