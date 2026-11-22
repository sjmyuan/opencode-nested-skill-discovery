import { describe, expect, it } from "vitest"
import type { Permission } from "@opencode/schema/permission"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

/**
 * F18 conformance, fixtures 3 (ADR agent A8, A13, A15, G8; C4): both sources reach one
 * registration through the delivered pipeline, the unreadable and legacy documents are
 * named and dropped, one bad `agents` key keeps its siblings, and an ID the host already
 * holds is left byte-identical.
 *
 * The merge/legacy/malformed paths are asserted at index level elsewhere
 * (`test/registry-agent-index.test.ts`, `test/agent-index.test.ts`); these cases are the
 * only end-to-end registration for them, and the held-ID case is the one the F17 gate left
 * unproven.
 */

interface Harness {
  readonly fixture: RegistryFixture
  readonly fake: FakeContext
  readonly registry: ReturnType<typeof createRegistry>
  dispose(): Promise<void>
}

interface HarnessOptions {
  readonly agents?: readonly { readonly id: string }[]
}

async function harness(
  seed: (fixture: RegistryFixture) => Promise<void>,
  options: HarnessOptions = {},
): Promise<Harness> {
  const fixture = await createRegistryFixture()
  await seed(fixture)
  const fake = fakeContext([], {
    directory: fixture.root,
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  })
  const registry = createRegistry(fake.ctx, { now: () => 0 })
  await registry.activate()

  return {
    fixture,
    fake,
    registry,
    async dispose() {
      await registry.dispose()
      await fixture.cleanup()
    },
  }
}

const listing = async (fake: FakeContext): Promise<readonly Record<string, unknown>[]> =>
  (await fake.ctx.agent.list()).data as readonly Record<string, unknown>[]

const shape = (rules: readonly Permission.Rule[]): readonly string[] =>
  rules.map((rule) => `${rule.action}:${rule.resource}:${rule.effect}`)

const SEED = ["*:*:allow", "read:*.env:ask", "read:*.env.*:ask", "read:*.env.example:allow"]

describe("both sources", () => {
  it("registers a file agent and a config agent of the same native name as one merged entry", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({
          agents: {
            shared: {
              description: "from config",
              mode: "all",
              permissions: [{ action: "edit", resource: "*", effect: "ask" }],
            },
          },
        }),
      )
      await fixture.write(
        "A/.opencode/agent/shared.md",
        "---\ndescription: from file\npermissions:\n  - action: read\n    resource: '*'\n    effect: deny\n---\n# From file\n",
      )
    })

    try {
      const entries = await listing(h.fake)
      expect(entries).toHaveLength(1)

      const [published] = entries
      // A8: the file ranks after the document, so it wins the fields it sets and the
      // document keeps the ones it alone declares. `opencode.json` owns the identity.
      expect(published?.name).toBe("A/shared")
      expect(published?.id).toBe("A/shared")
      expect(published?.description).toBe("from file")
      expect(published?.mode).toBe("all")
      expect(published?.system).toBe("# From file")
      expect(shape(published?.permissions as readonly Permission.Rule[])).toEqual([
        ...SEED,
        "edit:*:ask",
        "read:*:deny",
      ])
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-merge:"))).toEqual([
        "agent-merge: shared (A/opencode.json + A/.opencode/agent/shared.md)",
      ])
    } finally {
      await h.dispose()
    }
  })

  it("refuses a config agent whose key would put a wildcard in its id", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({ agents: { "star*": { description: "d" }, kept: { description: "d" } } }),
      )
    })

    try {
      const entries = await listing(h.fake)
      expect(entries.map((entry) => entry.name)).toEqual(["A/kept"])
      expect(entries.map((entry) => String(entry.id))).toEqual(["A/kept"])
      expect(entries.some((entry) => String(entry.id).includes("*"))).toBe(false)
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-skip: wildcard"))).toEqual([
        "agent-skip: wildcard A/opencode.json",
      ])
    } finally {
      await h.dispose()
    }
  })

  it("drops a legacy document by name and registers nothing from it", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/.opencode/agent/legacy.md",
        "---\ndescription: old\ntools:\n  bash: false\n---\n# Legacy\n",
      )
      await fixture.write("A/.opencode/agent/current.md", "# Current\n")
    })

    try {
      const entries = await listing(h.fake)
      expect(entries.map((entry) => entry.name)).toEqual(["A/current"])
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-skip:"))).toEqual([
        "agent-skip: legacy A/.opencode/agent/legacy.md",
      ])
    } finally {
      await h.dispose()
    }
  })

  it("drops a malformed document by name and registers nothing from it", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write("A/opencode.json", '{ "agents": { "unfinished": {} ')
      await fixture.write("A/.opencode/agent/current.md", "# Current\n")
    })

    try {
      const entries = await listing(h.fake)
      expect(entries.map((entry) => entry.name)).toEqual(["A/current"])
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-skip:"))).toEqual([
        "agent-skip: malformed A/opencode.json",
      ])
    } finally {
      await h.dispose()
    }
  })

  it("keeps the sibling entry and the document's top-level rules when one agents key fails schema", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({
          permissions: [{ action: "shell", resource: "*", effect: "deny" }],
          agents: { broken: { mode: "sideways" }, kept: { description: "d", mode: "subagent" } },
        }),
      )
    })

    try {
      const entries = await listing(h.fake)
      expect(entries.map((entry) => entry.name)).toEqual(["A/kept"])
      // A15: the failing key is dropped alone, so the surviving sibling still carries the
      // document's rules — the fail-closed direction for a nested `deny`.
      expect(shape(entries[0]?.permissions as readonly Permission.Rule[])).toEqual([...SEED, "shell:*:deny"])
      expect(h.registry.outcome.diagnostics).toContain("agent-skip: A/opencode.json: entry broken schema")
    } finally {
      await h.dispose()
    }
  })
})

describe("held ID", () => {
  it("leaves a host-held nested id byte-identical and names the skip once", async () => {
    const fixture = await createRegistryFixture()
    await fixture.write("A/.opencode/agent/translator.md", "---\ndescription: Translates\n---\n# Translator\n")

    // The literal ID the index mints for this file: the readable path, no hash in the base form.
    const id = "A/translator"

    const fake = fakeContext([], {
      directory: fixture.root,
      agents: [{ id, name: "host/translator", mode: "subagent", hidden: true }],
    })
    const registry = createRegistry(fake.ctx, { now: () => 0 })
    const before = JSON.stringify(fake.agentEntry(id))

    try {
      await registry.activate()

      // G8: the pre-registration listing seeds the held set, so the colliding candidate is
      // dropped instead of overwriting the host's row.
      expect(JSON.stringify(fake.agentEntry(id))).toBe(before)
      expect(registry.outcome.diagnostics.filter((line) => line.startsWith("agent-skip: id-held"))).toEqual([
        "agent-skip: id-held A/.opencode/agent/translator.md",
      ])
      expect(fake.agentTransforms).toHaveLength(1)

      await registry.refresh()

      expect(JSON.stringify(fake.agentEntry(id))).toBe(before)
      expect(registry.outcome.diagnostics.filter((line) => line.startsWith("agent-skip: id-held"))).toEqual([
        "agent-skip: id-held A/.opencode/agent/translator.md",
      ])
      expect(fake.agentTransforms).toHaveLength(1)
      // The delivered receipt the F17 gate mis-recorded: one seed read, one reload per swap,
      // one audit read per refresh, and never a second transform.
      expect([...fake.agentCalls]).toEqual(["list", "reload", "list", "reload", "list"])
    } finally {
      await registry.dispose()
      await fixture.cleanup()
    }
  })
})
