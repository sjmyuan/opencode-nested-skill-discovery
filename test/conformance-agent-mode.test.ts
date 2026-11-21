import { describe, expect, it } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeAgentSeed, type FakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

/**
 * F18 conformance, fixtures 1 (ADR agent G2; C4): every authored `mode` state and the absent
 * default reach the registered map unchanged, and `hidden` is a published field.
 *
 * What each case does NOT prove: the surfaces that consume the value are the host's. At the
 * pin the TUI picker keeps `mode !== "subagent" && !hidden` (`packages/tui/src/context/local.tsx:60`)
 * and the subagent list keeps `mode !== "primary" && !hidden`
 * (`packages/core/src/tool/plugin/subagent.ts:288-295`, `agents/mode-surfaces#c2-c4`). The
 * plugin's obligation is the published field, so these fixtures assert exactly that and the
 * membership claims stay `source`, never `live`.
 */

interface Harness {
  readonly fixture: RegistryFixture
  readonly fake: FakeContext
  readonly registry: ReturnType<typeof createRegistry>
  dispose(): Promise<void>
}

interface HarnessOptions {
  /** The rows the host map holds before the transform registers (G8, C4). */
  readonly agents?: readonly FakeAgentSeed[]
  readonly activate?: boolean
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
  if (options.activate !== false) await registry.activate()

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

/** The `agents` map entry a case declares, as the config document carries it. */
const oneAgent = (fields: Record<string, unknown>) => async (fixture: RegistryFixture) => {
  await fixture.write("A/opencode.json", JSON.stringify({ agents: { writer: fields } }))
}

const entry = async (fake: FakeContext): Promise<Record<string, unknown>> => {
  const listed = (await fake.ctx.agent.list()).data as readonly Record<string, unknown>[]
  expect(listed).toHaveLength(1)
  return listed[0] as Record<string, unknown>
}

describe("authored mode", () => {
  it("publishes all so the host can offer the agent in both surfaces", async () => {
    const h = await harness(oneAgent({ description: "d", mode: "all" }))

    try {
      const published = await entry(h.fake)
      expect(published.mode).toBe("all")
      expect(published.hidden).toBe(false)
      expect(published.name).toBe("A/writer")
      expect(published.id).toBe("A/writer")
    } finally {
      await h.dispose()
    }
  })

  it("publishes primary so the host keeps it out of the subagent list", async () => {
    const h = await harness(oneAgent({ description: "d", mode: "primary" }))

    try {
      const published = await entry(h.fake)
      expect(published.mode).toBe("primary")
      expect(published.hidden).toBe(false)
      expect(published.id).toBe("A/writer")
    } finally {
      await h.dispose()
    }
  })

  it("publishes subagent so the host keeps it out of the picker", async () => {
    const h = await harness(oneAgent({ description: "d", mode: "subagent" }))

    try {
      const published = await entry(h.fake)
      expect(published.mode).toBe("subagent")
      expect(published.hidden).toBe(false)
      expect(published.id).toBe("A/writer")
    } finally {
      await h.dispose()
    }
  })

  it("leaves an absent mode to the registry default, which the pin reads as primary", async () => {
    const h = await harness(oneAgent({ description: "d" }))

    try {
      const published = await entry(h.fake)
      // `Agent.Info.default` supplies `mode: "primary"` on the insert
      // (`packages/schema/src/agent.ts:38-52`, `agents/mode-surfaces#c5`); we publish no mode.
      expect(published.mode).toBe("primary")
      expect(published.hidden).toBe(false)
      expect(published.id).toBe("A/writer")
    } finally {
      await h.dispose()
    }
  })
})

describe("authored visibility", () => {
  it("publishes hidden and keeps the entry listed and resolvable by id", async () => {
    const h = await harness(oneAgent({ description: "d", mode: "subagent", hidden: true }))

    try {
      const published = await entry(h.fake)
      expect(published.hidden).toBe(true)

      // `hidden` removes the agent from the subagent advertisement and the picker, but the
      // call path tests only `mode === "primary"`, so the entry stays resolvable by id
      // (`agents/mode-surfaces#c6`, `agents/exposure#c6`).
      const resolved = await h.fake.ctx.agent.get({ agentID: String(published.id) })
      expect(resolved.data).toEqual(published)
    } finally {
      await h.dispose()
    }
  })
})

describe("inherited mode and visibility (G4)", () => {
  /** A config-document agent whose native name is also a runtime row's: the G4 match key. */
  const documentAgent = (name: string, fields: Record<string, unknown> = {}) => async (fixture: RegistryFixture) => {
    await fixture.write("A/opencode.json", JSON.stringify({ agents: { [name]: { description: "d", ...fields } } }))
  }

  const byName = async (fake: FakeContext, name: string): Promise<Record<string, unknown>> => {
    const listed = (await fake.ctx.agent.list()).data as readonly Record<string, unknown>[]
    const matched = listed.filter((entry) => entry.name === name)
    expect(matched).toHaveLength(1)
    return matched[0] as Record<string, unknown>
  }

  const auditLines = (h: Harness): readonly string[] =>
    h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-shadow-audit:"))

  it("publishes the same-named runtime entry's mode when the source authors none", async () => {
    const h = await harness(documentAgent("general"), {
      agents: [{ id: "general", name: "General", mode: "subagent", hidden: false }],
    })

    try {
      const published = await byName(h.fake, "A/general")
      // The builtin's listing `name` is its display title, so the match is on the ID; a seed
      // keyed on the name would leave this `primary`.
      expect(published.mode).toBe("subagent")
      expect(published.hidden).toBe(false)
      expect(published.id).toBe("A/general")
      expect(auditLines(h)).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("keeps an authored mode over the same-named runtime entry's", async () => {
    const h = await harness(documentAgent("general", { mode: "primary" }), {
      agents: [{ id: "general", name: "General", mode: "subagent", hidden: false }],
    })

    try {
      const published = await byName(h.fake, "A/general")
      expect(published.mode).toBe("primary")
      expect(auditLines(h)).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("falls back to the registry default when no runtime entry carries the name", async () => {
    const h = await harness(documentAgent("general"))

    try {
      const published = await byName(h.fake, "A/general")
      expect(published.mode).toBe("primary")
      expect(published.hidden).toBe(false)
      expect(published.id).toBe("A/general")
    } finally {
      await h.dispose()
    }
  })

  it("inherits hidden as well as mode", async () => {
    const h = await harness(documentAgent("planner"), {
      agents: [{ id: "planner", mode: "subagent", hidden: true }],
    })

    try {
      const published = await byName(h.fake, "A/planner")
      expect(published.mode).toBe("subagent")
      expect(published.hidden).toBe(true)
      expect(auditLines(h)).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("inherits only the field the source does not author", async () => {
    const h = await harness(documentAgent("general", { mode: "primary" }), {
      agents: [{ id: "general", name: "General", mode: "subagent", hidden: true }],
    })

    try {
      const published = await byName(h.fake, "A/general")
      // Per field: the authored `mode` wins and the unauthored `hidden` still inherits.
      expect(published.mode).toBe("primary")
      expect(published.hidden).toBe(true)
      expect(published.id).toBe("A/general")
      expect(auditLines(h)).toEqual([])

      // Published but unlisted: both surfaces drop it, yet it stays resolvable by ID.
      const resolved = await h.fake.ctx.agent.get({ agentID: String(published.id) })
      expect(resolved.data).toEqual(published)
    } finally {
      await h.dispose()
    }
  })

  it("leaves the same-named native row byte-identical across activation", async () => {
    const h = await harness(documentAgent("general"), {
      agents: [{ id: "general", name: "General", system: "builtin prompt", mode: "primary", hidden: false }],
      activate: false,
    })

    try {
      const before = await h.fake.ctx.agent.get({ agentID: "general" })
      await h.registry.activate()
      const after = await h.fake.ctx.agent.get({ agentID: "general" })

      // Insert-on-miss is what protects this row (`src/replay.ts:80`); a seed keyed on the
      // listing's `name` would instead miss ("general" ≠ "General"), leaving this `primary`,
      // which the inheritance case above catches. No seed key writes the builtin's title here.
      expect(after.data).toEqual(before.data)
    } finally {
      await h.dispose()
    }
  })

  it("inherits from a native entry whose id starts with nested.", async () => {
    const h = await harness(
      async (fixture) => {
        await fixture.write("A/.opencode/agent/nested.foo.md", "---\ndescription: d\n---\n# Foo\n")
      },
      { agents: [{ id: "nested.foo", mode: "subagent", hidden: true }] },
    )

    try {
      const published = await byName(h.fake, "A/nested.foo")
      // A native ID that happens to start with `nested.` is not ours: the seed excludes the
      // IDs the published snapshot owns, not a prefix (G4).
      expect(published.mode).toBe("subagent")
      expect(published.hidden).toBe(true)
      expect(published.id).toBe("A/nested.foo")
    } finally {
      await h.dispose()
    }
  })

  it("registers the identical pair on a second registry over the same fixture", async () => {
    const h = await harness(documentAgent("general"), {
      agents: [{ id: "general", name: "General", mode: "subagent", hidden: false }],
    })

    try {
      const first = await byName(h.fake, "A/general")
      const restart = fakeContext([], {
        directory: h.fixture.root,
        agents: [{ id: "general", name: "General", mode: "subagent", hidden: false }],
      })
      const registry = createRegistry(restart.ctx, { now: () => 0 })

      try {
        await registry.activate()
        const second = (await restart.ctx.agent.list()).data.find((entry) => entry.name === "A/general")
        expect({ id: String(second?.id), mode: second?.mode, hidden: second?.hidden }).toEqual({
          id: String(first.id),
          mode: first.mode,
          hidden: first.hidden,
        })
      } finally {
        await registry.dispose()
      }
    } finally {
      await h.dispose()
    }
  })
})
