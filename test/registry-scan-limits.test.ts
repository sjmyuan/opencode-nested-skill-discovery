import { afterEach, describe, expect, it } from "vitest"
import { setup } from "../src/plugin.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeContextOptions } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

const DOC = (name: string): string => `---\nname: ${name}\ndescription: ${name}.\n---\n# ${name}\n`

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

/**
 * Five subprojects, each with one skill. The location's own `.opencode/skills` is a
 * native root, so every advertised entry here comes from a subproject (F2/F3 split).
 */
async function wideFixture(): Promise<RegistryFixture> {
  const fixture = await createRegistryFixture()
  cleanups.push(() => fixture.cleanup())
  for (const name of ["A", "B", "C", "D", "E"]) {
    await fixture.write(`${name}/.opencode/skills/${name.toLowerCase()}.md`, DOC(name.toLowerCase()))
  }
  return fixture
}

interface Harness {
  readonly fixture: RegistryFixture
  readonly fake: ReturnType<typeof fakeContext>
  readonly registry: ReturnType<typeof createRegistry>
}

async function harness(options: FakeContextOptions = {}): Promise<Harness> {
  const fixture = await wideFixture()
  const fake = fakeContext([], { directory: fixture.root, ...options })
  const registry = createRegistry(fake.ctx)
  cleanups.push(() => registry.dispose())
  return { fixture, fake, registry }
}

const pathsOf = (fake: ReturnType<typeof fakeContext>): readonly string[] =>
  fake.editor.list().map((entry) => String(entry.path))

const budgetLines = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("budget-"))

describe("scan limits from options", () => {
  it("bounds the scan by a configured maxDirectories", async () => {
    const limited = await harness({ options: { maxDirectories: 3 } })
    const full = await harness()

    const outcome = await limited.registry.activate()
    const baseline = await full.registry.activate()

    expect(outcome.ok).toBe(true)
    expect(outcome.diagnostics).toContain("budget-directories: maxDirectories=3")
    expect(outcome.diagnostics).toContain("scan-truncated")
    expect(outcome.skills).toBe(1)
    expect(baseline.diagnostics).toEqual([])
    expect(baseline.skills).toBe(5)
  })

  it("bounds the scan by a configured maxFiles", async () => {
    const limited = await harness({ options: { maxFiles: 1 } })

    const outcome = await limited.registry.activate()

    expect(outcome.ok).toBe(true)
    expect(outcome.diagnostics).toContain("budget-files: maxFiles=1")
    expect(outcome.skills).toBe(1)
  })

  it("keeps maxDepth 0 at the location's own root", async () => {
    const shallow = await harness({ options: { maxDepth: 0 } })
    const full = await harness()

    const outcome = await shallow.registry.activate()
    const baseline = await full.registry.activate()

    expect(outcome.ok).toBe(true)
    expect(outcome.skills).toBe(0)
    expect(pathsOf(shallow.fake)).toEqual([])
    expect(baseline.skills).toBe(5)
  })

  it("leaves a zero-config run unbudgeted", async () => {
    const plain = await harness()
    const empty = await harness({ options: {} })

    const outcome = await plain.registry.activate()
    const withEmptyOptions = await empty.registry.activate()

    expect(budgetLines(outcome.diagnostics)).toEqual([])
    expect(outcome.diagnostics).not.toContain("scan-truncated")
    expect(outcome.skills).toBe(5)
    expect(withEmptyOptions.skills).toBe(outcome.skills)
    expect(withEmptyOptions.diagnostics).toEqual(outcome.diagnostics)
  })

  it("threads the options through setup", async () => {
    const fixture = await wideFixture()
    const configured = fakeContext([], { directory: fixture.root, options: { maxDepth: 0 } })
    const plain = fakeContext([], { directory: fixture.root })

    for (const fake of [configured, plain]) {
      const stop = await setup(fake.ctx)
      if (typeof stop === "function") cleanups.push(async () => stop())
    }

    expect(pathsOf(configured)).toEqual([])
    expect(pathsOf(plain)).toHaveLength(5)
  })
})
