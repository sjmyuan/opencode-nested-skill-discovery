import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { setup } from "../src/plugin.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeContextOptions } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"
import { createFixture } from "./support/scan-fixtures.ts"

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

describe("invalid scan options", () => {
  it("reports one line for a rejected key and still activates", async () => {
    const limited = await harness({ options: { maxFiles: "7" } })

    const outcome = await limited.registry.activate()

    expect(outcome.ok).toBe(true)
    expect(outcome.diagnostics.filter((line) => line.startsWith("option-invalid:"))).toEqual([
      'option-invalid: maxFiles="7"',
    ])
    // The default budget still applies, so all five skills are advertised.
    expect(outcome.skills).toBe(5)
  })

  it("reports several rejected keys in declaration order and nothing else", async () => {
    const fixture = await createRegistryFixture()
    cleanups.push(() => fixture.cleanup())
    const fake = fakeContext([], { directory: fixture.root, options: { maxDepth: -1, maxTotalBytes: Infinity } })
    const registry = createRegistry(fake.ctx)
    cleanups.push(() => registry.dispose())

    const outcome = await registry.activate()

    expect(outcome.ok).toBe(true)
    expect(outcome.diagnostics).toEqual([
      "option-invalid: maxDepth=-1",
      "option-invalid: maxTotalBytes=Infinity",
    ])
  })

  it("stays silent for an unknown key and scans at the defaults", async () => {
    const typo = await harness({ options: { maxDirectorie: 500 } })

    const outcome = await typo.registry.activate()

    expect(outcome.ok).toBe(true)
    expect(outcome.diagnostics.some((line) => line.startsWith("option-invalid:"))).toBe(false)
    expect(outcome.skills).toBe(5)
  })

  it("keeps the option line first under the 200-line cap", async () => {
    const fixture = await createFixture()
    cleanups.push(() => fixture.cleanup())
    for (let index = 0; index < 205; index += 1) {
      await fixture.symlink(
        `A/.opencode/skills/broken-${String(index).padStart(3, "0")}.md`,
        join(fixture.root, "missing", `${index}.md`),
      )
    }
    const fake = fakeContext([], { directory: fixture.root, options: { maxFiles: "7" } })
    const registry = createRegistry(fake.ctx)
    cleanups.push(() => registry.dispose())

    const outcome = await registry.activate()

    expect(outcome.ok).toBe(true)
    expect(outcome.diagnostics).toHaveLength(200)
    expect(outcome.diagnostics[0]).toBe('option-invalid: maxFiles="7"')
    expect(outcome.diagnostics[199]).toMatch(/^truncated: \d+ more diagnostics$/)
  })

  it("repeats the line on every refresh", async () => {
    const limited = await harness({ options: { maxFiles: "7" } })

    const first = await limited.registry.activate()
    const second = await limited.registry.refresh()

    for (const outcome of [first, second]) {
      expect(outcome.diagnostics.filter((line) => line.startsWith("option-invalid:"))).toEqual([
        'option-invalid: maxFiles="7"',
      ])
    }
  })
})

interface Nested {
  readonly fixture: RegistryFixture
  readonly outer: ReturnType<typeof createRegistry>
  readonly inner: ReturnType<typeof createRegistry>
  readonly outerFake: ReturnType<typeof fakeContext>
  readonly innerFake: ReturnType<typeof fakeContext>
}

/** `<root>` and `<root>/pkg` are two locations; each sees only its own options (RD5). */
async function nested(outerOptions: FakeContextOptions["options"], innerOptions: FakeContextOptions["options"]): Promise<Nested> {
  const fixture = await createRegistryFixture()
  cleanups.push(() => fixture.cleanup())
  await fixture.write("pkg/A/.opencode/skills/a.md", DOC("a"))
  await fixture.write("pkg/B/.opencode/skills/b.md", DOC("b"))
  const pkg = await fixture.realpathOf("pkg")
  const outerFake = fakeContext([], { directory: fixture.root, options: outerOptions })
  const innerFake = fakeContext([], { directory: pkg, options: innerOptions })
  const outer = createRegistry(outerFake.ctx)
  const inner = createRegistry(innerFake.ctx)
  cleanups.push(() => outer.dispose(), () => inner.dispose())
  return { fixture, outer, inner, outerFake, innerFake }
}

describe("per-location scan limits", () => {
  it("keeps an outer budget out of the inner registry", async () => {
    const pair = await nested({ maxDirectories: 3 }, undefined)

    const outerFirst = await pair.outer.activate()
    const innerFirst = await pair.inner.activate()

    expect(outerFirst.ok).toBe(true)
    expect(outerFirst.diagnostics).toContain("budget-directories: maxDirectories=3")
    expect(outerFirst.diagnostics).toContain("scan-truncated")
    expect(innerFirst.diagnostics).not.toContain("scan-truncated")
    expect(innerFirst.skills).toBe(2)

    const outerSecond = await pair.outer.refresh()
    const innerSecond = await pair.inner.refresh()

    expect(outerSecond.diagnostics).toContain("scan-truncated")
    expect(innerSecond.diagnostics).not.toContain("scan-truncated")
    expect(innerSecond.skills).toBe(2)
    expect(pair.innerFake.editor.list()).toHaveLength(2)
  })

  it("keeps an inner budget out of the outer registry", async () => {
    const pair = await nested(undefined, { maxDirectories: 3 })

    const outerFirst = await pair.outer.activate()
    const innerFirst = await pair.inner.activate()

    expect(outerFirst.ok).toBe(true)
    expect(outerFirst.diagnostics).not.toContain("scan-truncated")
    expect(outerFirst.skills).toBe(2)
    expect(innerFirst.diagnostics).toContain("budget-directories: maxDirectories=3")
    expect(innerFirst.diagnostics).toContain("scan-truncated")
    expect(innerFirst.skills).toBe(1)

    const outerSecond = await pair.outer.refresh()
    const innerSecond = await pair.inner.refresh()

    expect(outerSecond.skills).toBe(2)
    expect(outerSecond.diagnostics).not.toContain("scan-truncated")
    expect(innerSecond.skills).toBe(1)
    expect(innerSecond.diagnostics).toContain("scan-truncated")
  })
})
