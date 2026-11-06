import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import { createRegistry, type Registry } from "../src/registry.ts"
import { fakeContext, nativeSkill, type FakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

const ID_SHAPE = /^nested\.[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\.[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/

const DEPLOY_A = "---\nname: deploy\ndescription: Deploys pkg-a\n---\n# Deploy\n\nDeploys pkg-a.\n"
const FOO_A = "---\nname: foo\n---\n# Foo\n\nFoocraft.\n"
const DEPLOY_B = "---\nname: deploy\ndescription: Deploys pkg-b\n---\n# Deploy\n\nDeploys pkg-b.\n"
const TIDY_C = "---\nname: tidy\ndescription: 'Deploy \"safe\" & <fast>'\ndisable-model-invocation: true\n---\n# Tidy\n"
const LINT_D = "---\nname: lint\n---\n# Lint\n"

interface Conformance {
  readonly fixture: RegistryFixture
  readonly fake: FakeContext
  readonly registry: Registry
}

async function seedWorkspace(fixture: RegistryFixture): Promise<void> {
  await fixture.write(".opencode/skills/native-root/SKILL.md", DEPLOY_A)
  await fixture.write(".opencode/skills/at-location.md", FOO_A)
  await fixture.write("pkg-a/.opencode/skills/deploy/SKILL.md", DEPLOY_A)
  await fixture.write("pkg-a/.opencode/skills/foo.md", FOO_A)
  await fixture.write("pkg-b/.claude/skills/deploy/SKILL.md", DEPLOY_B)
  await fixture.write("pkg-c/.agents/skills/tidy/SKILL.md", TIDY_C)
  await fixture.write("pkg-d/AGENTS.md", "# pkg-d\n")
  await fixture.write("pkg-d/deep/nest/.opencode/skill/lint/SKILL.md", LINT_D)
  await fixture.write("pkgs/d1/d2/d3/d4/d5/d6/.opencode/skills/hidden/SKILL.md", LINT_D)
}

const nested = (fake: FakeContext) => fake.editor.list().filter((entry) => entry.id.startsWith("nested."))
const byName = (fake: FakeContext, name: string) => nested(fake).find((entry) => entry.name === name)

async function expectedId(
  fixture: RegistryFixture,
  subproject: string,
  nativeId: string,
  file: string,
): Promise<string> {
  return `nested.${scopeTokenFor(await fixture.realpathOf(subproject))}.${skillTokenFor(
    nativeId,
    await fixture.realpathOf(file),
  )}`
}

let active: Conformance | undefined

beforeEach(() => {
  active = undefined
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await active?.registry.dispose()
  await active?.fixture.cleanup()
})

async function run(): Promise<Conformance> {
  const fixture = await createRegistryFixture()
  vi.stubEnv("OPENCODE_TEST_HOME", `${fixture.root}/home`)
  vi.stubEnv("OPENCODE_CONFIG_DIR", `${fixture.root}/home/.config/opencode`)
  await seedWorkspace(fixture)
  const fake = fakeContext([nativeSkill("native-alpha"), nativeSkill("native-beta")], {
    directory: fixture.root,
  })
  const registry = createRegistry(fake.ctx)
  active = { fixture, fake, registry }
  await registry.activate()
  return active
}

describe("conformance: advertised union", () => {
  it("advertises every nested skill with its exact path-hash id", async () => {
    const { fixture, fake } = await run()

    const expected = {
      "pkg-a/deploy": await expectedId(fixture, "pkg-a", "deploy", "pkg-a/.opencode/skills/deploy/SKILL.md"),
      "pkg-a/foo": await expectedId(fixture, "pkg-a", "foo", "pkg-a/.opencode/skills/foo.md"),
      "pkg-b/deploy": await expectedId(fixture, "pkg-b", "deploy", "pkg-b/.claude/skills/deploy/SKILL.md"),
      "pkg-c/tidy": await expectedId(fixture, "pkg-c", "tidy", "pkg-c/.agents/skills/tidy/SKILL.md"),
      "pkg-d/deep/nest/lint": await expectedId(
        fixture,
        "pkg-d/deep/nest",
        "lint",
        "pkg-d/deep/nest/.opencode/skill/lint/SKILL.md",
      ),
    }

    expect(Object.fromEntries(nested(fake).map((entry) => [entry.name, entry.id]))).toEqual(expected)
  })

  it("uses the documented id shape for every nested entry", async () => {
    const { fake } = await run()

    for (const entry of nested(fake)) {
      expect(entry.id).toMatch(ID_SHAPE)
    }
  })

  it("qualifies nested names uniquely and contains a path separator", async () => {
    const { fake } = await run()

    const names = nested(fake).map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.every((name) => name.includes("/"))).toBe(true)
  })

  it("names a deeply nested skill after its deepest marker", async () => {
    const { fake } = await run()

    expect(byName(fake, "pkg-d/deep/nest/lint")).toBeDefined()
    expect(byName(fake, "pkg-d/lint")).toBeUndefined()
    expect(byName(fake, "lint")).toBeUndefined()
  })

  it("sanitizes the description and carries autoinvoke false", async () => {
    const { fake } = await run()

    const tidy = byName(fake, "pkg-c/tidy")
    expect(tidy?.description).toBe("Deploy safe fast")
    expect(tidy?.autoinvoke).toBe(false)
  })

  it("hides the depth-6 subproject and every skill inside a native root", async () => {
    const { fixture, fake } = await run()
    const paths = nested(fake).map((entry) => entry.path)
    const root = fixture.realRoot

    expect(paths.some((path) => path.includes("/hidden/"))).toBe(false)
    expect(paths.some((path) => path.startsWith(`${root}/.opencode/`))).toBe(false)
    expect(nested(fake).some((entry) => entry.name.endsWith("/native-root"))).toBe(false)
  })

  it("leaves the seeded native entries byte-identical and listed first", async () => {
    const { fake } = await run()
    const seeds = [nativeSkill("native-alpha"), nativeSkill("native-beta")]

    expect(fake.editor.list().slice(0, seeds.length)).toEqual(seeds)
    expect(fake.editor.list().length).toBe(seeds.length + 5)
  })

  it("registers one transform and reports four subprojects", async () => {
    const { fixture, fake, registry } = await run()
    const root = fixture.realRoot

    expect(fake.transforms).toHaveLength(1)
    expect(registry.outcome.subprojects).toBe(4)
    expect(registry.outcome.ok).toBe(true)
    for (const entry of nested(fake)) {
      expect(entry.path.startsWith(`${root}/`)).toBe(true)
    }
  })
})
