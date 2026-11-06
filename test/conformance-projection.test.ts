import { afterEach, describe, expect, it, vi } from "vitest"
import type { Skill } from "@opencode/plugin"
import type { RegistrySnapshot } from "../src/contracts.ts"
import { scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import { applySnapshot } from "../src/plugin.ts"
import { createRegistry, type Registry } from "../src/registry.ts"
import { fakeContext, nativeSkill, type FakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

const DEPLOY_A = "---\nname: deploy\ndescription: Deploys pkg-a\n---\n# Deploy\n\nDeploys pkg-a.\n"
const TIDY_C = "---\nname: tidy\ndescription: 'Deploy \"safe\" & <fast>'\ndisable-model-invocation: true\n---\n# Tidy\n\nTidy up.\n"

const INFO_KEYS = ["content", "description", "id", "name", "path"]

interface Activated {
  readonly fixture: RegistryFixture
  readonly fake: FakeContext
  readonly registry: Registry
}

let active: Activated | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await active?.registry.dispose()
  await active?.fixture.cleanup()
  active = undefined
})

async function activated(): Promise<Activated> {
  const fixture = await createRegistryFixture()
  vi.stubEnv("OPENCODE_TEST_HOME", `${fixture.root}/home`)
  vi.stubEnv("OPENCODE_CONFIG_DIR", `${fixture.root}/home/.config/opencode`)
  await fixture.write("pkg-a/.opencode/skills/deploy/SKILL.md", DEPLOY_A)
  await fixture.write("pkg-c/.agents/skills/tidy/SKILL.md", TIDY_C)
  const fake = fakeContext([nativeSkill("native-alpha")], { directory: fixture.root })
  const registry = createRegistry(fake.ctx)
  active = { fixture, fake, registry }
  await registry.activate()
  return active
}

const nested = (fake: FakeContext) => fake.editor.list().find((entry) => String(entry.id).startsWith("nested."))

async function deployId(fixture: RegistryFixture): Promise<string> {
  return `nested.${scopeTokenFor(await fixture.realpathOf("pkg-a"))}.${skillTokenFor(
    "deploy",
    await fixture.realpathOf("pkg-a/.opencode/skills/deploy/SKILL.md"),
  )}`
}

describe("conformance: Skill.Info projection", () => {
  it("projects exactly the host fields and never the internal snapshot shape", async () => {
    const { fake } = await activated()
    const entry = nested(fake)

    expect(entry).toBeDefined()
    expect(Object.keys(entry ?? {}).sort()).toEqual(INFO_KEYS)
    expect(entry).not.toHaveProperty("subproject")
    expect(entry).not.toHaveProperty("canonicalPath")
  })

  it("projects the exact id, qualified name, canonical path, body, and sanitized values", async () => {
    const { fixture, fake } = await activated()
    const deploy = fake.editor.list().find((entry) => String(entry.name) === "pkg-a/deploy")
    const tidy = fake.editor.list().find((entry) => String(entry.name) === "pkg-c/tidy")

    expect(deploy).toEqual({
      id: await deployId(fixture),
      name: "pkg-a/deploy",
      description: "Deploys pkg-a",
      path: await fixture.realpathOf("pkg-a/.opencode/skills/deploy/SKILL.md"),
      content: "# Deploy\n\nDeploys pkg-a.\n",
    })
    expect(Object.keys(tidy ?? {}).sort()).toEqual([...INFO_KEYS, "autoinvoke"].sort())
    expect(tidy?.description).toBe("Deploy safe fast")
    expect(tidy?.autoinvoke).toBe(false)
  })

  it("replays the same snapshot idempotently through the get guard", async () => {
    const { registry } = await activated()
    const fake = fakeContext([])

    applySnapshot(fake.editor, registry.snapshot)
    const once = fake.editor.list().map((entry) => ({ ...entry }))
    applySnapshot(fake.editor, registry.snapshot)

    expect(fake.editor.list()).toEqual(once)
    expect(once).toHaveLength(2)
  })

  it("never overwrites an entry that already holds a nested id", async () => {
    const { fixture, registry } = await activated()
    const existing = {
      id: await deployId(fixture),
      name: "pkg-a/deploy",
      path: "/tmp/owned/SKILL.md",
      content: "# Owned\n",
    } as Skill.Info
    const fake = fakeContext([existing])

    applySnapshot(fake.editor, registry.snapshot)

    expect(fake.editor.get(existing.id)).toEqual(existing)
    expect(fake.editor.list()).toHaveLength(2)
  })

  it("leaves the list byte-identical for an empty snapshot and a no-op for undefined", async () => {
    const fake = fakeContext([nativeSkill("native-alpha"), nativeSkill("native-beta")])
    const before = fake.editor.list().map((entry) => ({ ...entry }))
    const empty: RegistrySnapshot = {
      location: "/tmp/location",
      snapshots: [{ scopeToken: "empty-00000000", directory: "/tmp/location", skills: [] }],
    }

    applySnapshot(fake.editor, empty)
    applySnapshot(fake.editor, undefined)

    expect(fake.editor.list()).toEqual(before)
  })
})
