import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

/**
 * F18 conformance, fixtures 4 (ADR agent A10, A13, A2; C4): the document boundary cases the
 * F16 gate deferred, driven through registration rather than through the reader alone.
 *
 * The caps (40 MB `cap-file`, one read per token) and the outward-link refusal are pinned at
 * unit level in `test/agent-config.test.ts:158-334` and were re-read before writing this
 * file: they still exist, so this file adds only the registration-level cases and asserts no
 * cap here.
 */

interface Harness {
  readonly fixture: RegistryFixture
  readonly fake: FakeContext
  readonly registry: ReturnType<typeof createRegistry>
  dispose(): Promise<void>
}

async function harness(seed: (fixture: RegistryFixture, outside: string) => Promise<void>): Promise<Harness> {
  const fixture = await createRegistryFixture()
  const outside = await mkdtemp(join(tmpdir(), "nested-conformance-outside-"))
  await seed(fixture, outside)
  const fake = fakeContext([], { directory: fixture.root })
  const registry = createRegistry(fake.ctx, { now: () => 0 })
  await registry.activate()

  return {
    fixture,
    fake,
    registry,
    async dispose() {
      await registry.dispose()
      await fixture.cleanup()
      await rm(outside, { recursive: true, force: true })
    },
  }
}

const listing = async (fake: FakeContext): Promise<readonly Record<string, unknown>[]> =>
  (await fake.ctx.agent.list()).data as readonly Record<string, unknown>[]

const byName = (entries: readonly Record<string, unknown>[]): Readonly<Record<string, Record<string, unknown>>> =>
  Object.fromEntries(entries.map((entry) => [String(entry.name), entry]))

const refusals = (registry: Harness["registry"]): readonly string[] =>
  registry.outcome.diagnostics.filter((line) => line.includes("file-ref"))

describe("substitution refusals through registration", () => {
  it("registers each refused reference with an empty substitution and one line per token", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write("A/dir/placeholder", "x")
      await symlink(join(fixture.root, "A/nope.txt"), join(fixture.root, "A/broken.txt"))
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({
          agents: {
            missing: { system: "{file:missing.txt}", mode: "subagent" },
            broken: { system: "{file:broken.txt}", mode: "subagent" },
            notfile: { system: "{file:dir}", mode: "subagent" },
          },
        }),
      )
    })

    try {
      const entries = byName(await listing(h.fake))
      expect(Object.keys(entries).sort()).toEqual(["A/broken", "A/missing", "A/notfile"])
      // A refused reference substitutes empty, so the agent still registers with its prompt
      // emptied — the refusal costs the reference, never the entry.
      for (const name of ["A/broken", "A/missing", "A/notfile"]) {
        expect(entries[name]?.system).toBe("")
      }
      expect([...refusals(h.registry)].sort()).toEqual([
        "agent-skip: A/opencode.json: file-ref {file:broken.txt} outside-root",
        "agent-skip: A/opencode.json: file-ref {file:dir} outside-root",
        "agent-skip: A/opencode.json: file-ref {file:missing.txt} outside-root",
      ])
    } finally {
      await h.dispose()
    }
  })

  it("substitutes an inward symlink like a regular file", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write("A/real.txt", "inward content")
      await symlink(join(fixture.root, "A/real.txt"), join(fixture.root, "A/link.txt"))
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({ agents: { inward: { system: "{file:link.txt}", mode: "subagent" } } }),
      )
    })

    try {
      const entries = byName(await listing(h.fake))
      expect(entries["A/inward"]?.system).toBe("inward content")
      expect(refusals(h.registry)).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("refuses an outward link and an intermediate-directory escape", async () => {
    const h = await harness(async (fixture, outside) => {
      await writeFile(join(outside, "secret.txt"), "secret")
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({
          agents: {
            outward: { system: "{file:out.txt}", mode: "subagent" },
            middle: { system: "{file:sub/secret.txt}", mode: "subagent" },
          },
        }),
      )
      await symlink(join(outside, "secret.txt"), join(fixture.root, "A/out.txt"))
      await symlink(outside, join(fixture.root, "A/sub"))
    })

    try {
      const entries = byName(await listing(h.fake))
      expect(entries["A/outward"]?.system).toBe("")
      expect(entries["A/middle"]?.system).toBe("")
      expect([...refusals(h.registry)].sort()).toEqual([
        "agent-skip: A/opencode.json: file-ref {file:out.txt} outside-root",
        "agent-skip: A/opencode.json: file-ref {file:sub/secret.txt} outside-root",
      ])
    } finally {
      await h.dispose()
    }
  })
})

describe("markers", () => {
  it("does not treat Opencode.json as a marker or a config document", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/Opencode.json",
        JSON.stringify({ agents: { hidden: { description: "d", mode: "subagent" } } }),
      )
    })

    try {
      // A2: the project marker is an exact name test on the directory listing, and the
      // config-document names are exact too (`src/contracts.ts:237-244`), so a differently
      // cased file is neither. A is an ordinary directory: nothing is read, nothing is
      // registered, and no agent diagnostic is spent on it.
      expect(await listing(h.fake)).toEqual([])
      expect(h.registry.agents).toEqual([])
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent"))).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("pins a symlinked .opencode: a name-matched marker whose document is read through, and whose roots are not walked", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/real/.opencode-doc/opencode.json",
        JSON.stringify({ agents: { linked: { description: "d", mode: "subagent" } } }),
      )
      await fixture.write("A/real/.opencode-doc/agent/filed.md", "# File agent\n")
      await symlink(join(fixture.root, "A/real/.opencode-doc"), join(fixture.root, "A/.opencode"))
    })

    try {
      const entries = byName(await listing(h.fake))

      // A3: `.opencode` matches the marker by name with no type test (`src/scan.ts:752-757`),
      // so `A` is a subproject; the linked root itself is never walked (`src/scan.ts:203-206`).
      // Its document is read only because `realpath(A/.opencode/opencode.json)` stays inside
      // `realpath(A)`; a target outside the subproject is refused with `config-symlink:` and
      // never opened (`src/scan.ts:641-654`). The file agent beside the document is inside the
      // linked root, so it stays invisible while the document it shares a directory with does not.
      expect(Object.keys(entries).sort()).toEqual(["A/linked", "A/real/.opencode-doc/linked"])
      expect(entries["A/linked"]?.system).toBeUndefined()
      // The document inside the linked root is not scanned as an agent file, so the file agent
      // beside it never reaches the map.
      expect(Object.values(entries).some((entry) => String(entry.name).endsWith("/filed"))).toBe(false)

      // The target directory is a subproject in its own right (it holds a config document),
      // which is what makes the same agent appear under a second scope without any link.
      expect(h.registry.agents.map((agent) => agent.name).sort()).toEqual(["linked", "linked"])

      expect(h.registry.outcome.diagnostics).toContain("directory-symlink: A/.opencode")
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-skip:"))).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("refuses a document reached through a linked .opencode that leaves the subproject", async () => {
    const h = await harness(async (fixture, outside) => {
      await writeFile(
        join(outside, "opencode.json"),
        JSON.stringify({ agents: { stolen: { system: "PWN", mode: "subagent" } } }),
      )
      await fixture.mkdirp("A")
      await symlink(outside, join(fixture.root, "A/.opencode"))
    })

    try {
      expect(await listing(h.fake)).toEqual([])
      expect(h.registry.agents).toEqual([])
      expect(
        h.registry.outcome.diagnostics.filter((line) => line === "config-symlink: A/.opencode/opencode.json"),
      ).toHaveLength(1)
      expect(h.registry.outcome.diagnostics).toContain("directory-symlink: A/.opencode")
      expect(refusals(h.registry)).toEqual([])
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("budget-"))).toEqual([])
    } finally {
      await h.dispose()
    }
  })
})
