import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Permission } from "@opencode/schema/permission"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeAgentSeed, type FakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

const replayControl = vi.hoisted(() => ({ payloadError: undefined as Error | undefined }))

vi.mock("../src/replay.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/replay.ts")>()
  return {
    ...actual,
    applyAgents: (
      editor: Parameters<typeof actual.applyAgents>[0],
      agents: Parameters<typeof actual.applyAgents>[1],
      seed: Parameters<typeof actual.applyAgents>[2],
    ) => {
      if (replayControl.payloadError !== undefined) throw replayControl.payloadError
      return actual.applyAgents(editor, agents, seed)
    },
  }
})

beforeEach(() => {
  replayControl.payloadError = undefined
})

/**
 * F17 Step 5 (ADR agent G1, G8–G11; C3, C4): one early `ctx.agent.transform` replays a frozen
 * projection of the agent index into the host map, native and config entries are never written,
 * one `reload()` follows each swap, and a second refresh is idempotent.
 */

interface Harness {
  readonly fixture: RegistryFixture
  readonly fake: FakeContext
  readonly registry: ReturnType<typeof createRegistry>
  dispose(): Promise<void>
}

interface HarnessOptions {
  readonly agents?: readonly FakeAgentSeed[]
  readonly agentConfigRules?: readonly Permission.Rule[]
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
    ...(options.agentConfigRules === undefined ? {} : { agentConfigRules: options.agentConfigRules }),
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

const listing = async (fake: FakeContext): Promise<readonly Record<string, unknown>[]> =>
  (await fake.ctx.agent.list()).data as readonly Record<string, unknown>[]

const byName = (entries: readonly Record<string, unknown>[]): Readonly<Record<string, Record<string, unknown>>> =>
  Object.fromEntries(entries.map((entry) => [String(entry.name), entry]))

const withBoth = async (fixture: RegistryFixture): Promise<void> => {
  await fixture.write(
    "A/.opencode/agent/translator.md",
    "---\ndescription: Translates releases\nmode: subagent\n---\n# Translator\n",
  )
  await fixture.write(
    "A/opencode.json",
    JSON.stringify({ agents: { reviewer: { description: "Reviews changes", mode: "all", hidden: false } } }),
  )
}

describe("publication", () => {
  it("registers both sources under their qualified names with the authored mode and hidden", async () => {
    const h = await harness(withBoth)

    try {
      const entries = byName(await listing(h.fake))
      expect(Object.keys(entries).sort()).toEqual(["A/reviewer", "A/translator"])
      expect(entries["A/translator"]?.mode).toBe("subagent")
      expect(entries["A/translator"]?.hidden).toBe(false)
      expect(entries["A/translator"]?.system).toBe("# Translator")
      expect(entries["A/reviewer"]?.mode).toBe("all")
      expect(entries["A/reviewer"]?.hidden).toBe(false)
      for (const entry of Object.values(entries)) {
        expect(String(entry.id)).toMatch(/^nested\.[a-z0-9-]+\.[a-z0-9-]+$/)
      }
      expect(h.registry.outcome.ok).toBe(true)
    } finally {
      await h.dispose()
    }
  })

  it("leaves the registry default in place when the source authors no mode and no hidden", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write("A/opencode.json", JSON.stringify({ agents: { bare: { description: "d" } } }))
    })

    try {
      const [entry] = await listing(h.fake)
      expect(entry?.name).toBe("A/bare")
      expect(entry?.mode).toBe("primary")
      expect(entry?.hidden).toBe(false)
    } finally {
      await h.dispose()
    }
  })
})

describe("registration order", () => {
  it("reads the listing once before the single transform registers, then reloads", async () => {
    const h = await harness(withBoth)

    try {
      // The seed read comes first, then the swap's reload; the audit's read follows it.
      expect(h.fake.agentCalls.slice(0, 2)).toEqual(["list", "reload"])
      expect(h.fake.agentTransforms).toHaveLength(1)
      // One seed read plus one audit read per refresh — never a second seed.
      expect(h.fake.agentCalls.filter((call) => call === "list")).toHaveLength(2)

      await h.registry.refresh()

      expect(h.fake.agentTransforms).toHaveLength(1)
      expect(h.fake.agentCalls.filter((call) => call === "list")).toHaveLength(3)
    } finally {
      await h.dispose()
    }
  })

  it("makes no ctx.agent call and no reload before activation", async () => {
    const h = await harness(withBoth, { activate: false })

    try {
      expect(h.fake.agentCalls).toEqual([])
      expect(h.fake.agentTransforms).toEqual([])
      expect(h.fake.agentReloadCalls).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it("reloads once per refresh", async () => {
    const h = await harness(withBoth)

    try {
      expect(h.fake.agentReloadCalls).toBe(1)
      await h.registry.refresh()
      expect(h.fake.agentReloadCalls).toBe(2)
      expect(h.fake.agentCalls.filter((call) => call === "reload")).toHaveLength(2)
    } finally {
      await h.dispose()
    }
  })

  it("is idempotent across a second refresh", async () => {
    const h = await harness(withBoth)

    try {
      const before = await listing(h.fake)
      await h.registry.refresh()
      const after = await listing(h.fake)

      expect(after).toHaveLength(before.length)
      expect([...after].sort((left, right) => String(left.id).localeCompare(String(right.id)))).toEqual(
        [...before].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      )
    } finally {
      await h.dispose()
    }
  })
})

describe("native entries", () => {
  it("leaves every native entry byte-identical across activation and a refresh", async () => {
    const rules: Permission.Rule[] = [{ action: "bash", resource: "*", effect: "deny" }]
    const fixture = await createRegistryFixture()
    await fixture.write("A/opencode.json", JSON.stringify({ agents: { reviewer: {} } }))
    const fake = fakeContext([], {
      directory: fixture.root,
      agents: [{ id: "build" }, { id: "plan", mode: "subagent" }],
      agentConfigRules: rules,
    })
    const registry = createRegistry(fake.ctx, { now: () => 0 })
    const buildBefore = JSON.stringify(fake.agentEntry("build"))
    const planBefore = JSON.stringify(fake.agentEntry("plan"))

    try {
      await registry.activate()

      expect(JSON.stringify(fake.agentEntry("build"))).toBe(buildBefore)
      expect(JSON.stringify(fake.agentEntry("plan"))).toBe(planBefore)
      expect(fake.agentEntry("plan")?.mode).toBe("subagent")

      await registry.refresh()

      expect(JSON.stringify(fake.agentEntry("build"))).toBe(buildBefore)
      expect(JSON.stringify(fake.agentEntry("plan"))).toBe(planBefore)
      expect(fake.agentDefaultCalls).toBe(0)
      expect(fake.agentRemoveCalls).toBe(0)
    } finally {
      await registry.dispose()
      await fixture.cleanup()
    }
  })
})

describe("admission diagnostics", () => {
  it("omits a disabled config agent and names it once", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({ agents: { gone: { description: "d", disabled: true }, kept: {} } }),
      )
    })

    try {
      const names = (await listing(h.fake)).map((entry) => entry.name)
      expect(names).toEqual(["A/kept"])
      expect(h.registry.outcome.diagnostics).toEqual(["agent-skip: disabled A/opencode.json"])
    } finally {
      await h.dispose()
    }
  })

  it("names an admitted request overlay once and carries it into the map", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({
          agents: { overlay: { request: { headers: { "x-a": "1" }, body: { temperature: 0.2 } } } },
        }),
      )
    })

    try {
      const [entry] = await listing(h.fake)
      expect(entry?.request).toEqual({ settings: {}, headers: { "x-a": "1" }, body: { temperature: 0.2 } })
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-request:"))).toEqual([
        `agent-request: ${String(entry?.id)}`,
      ])
    } finally {
      await h.dispose()
    }
  })

  it("emits no agent diagnostic for a plain agent document", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy\n")
      await fixture.write("A/.opencode/agent/translator.md", "# Translator\n")
    })

    try {
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent"))).toEqual([])
      expect((await listing(h.fake)).map((entry) => entry.name)).toEqual(["A/translator"])
    } finally {
      await h.dispose()
    }
  })
})

describe("audit", () => {
  const shadowId = async (fake: FakeContext): Promise<string> =>
    String((await fake.ctx.agent.list()).data.find((entry) => entry.name === "A/reviewer")?.id)

  it("reports a hand-edited entry once, then holds it out by omission", async () => {
    const h = await harness(withBoth)

    try {
      const id = await shadowId(h.fake)
      h.fake.setAgent(id, { description: "edited" })

      const second = await h.registry.refresh()

      expect(second.diagnostics.filter((line) => line.startsWith("agent-shadow-audit:"))).toEqual([
        `agent-shadow-audit: ${id}`,
      ])
      expect((await listing(h.fake)).some((entry) => String(entry.id) === id)).toBe(true)

      const third = await h.registry.refresh()

      expect(third.diagnostics.filter((line) => line.startsWith("agent-shadow-audit:"))).toEqual([])
      expect(third.diagnostics.filter((line) => line.startsWith("agent-skip: shadowed"))).toEqual([
        "agent-skip: shadowed A/opencode.json",
      ])
      expect((await listing(h.fake)).some((entry) => String(entry.id) === id)).toBe(false)
      expect(h.registry.outcome.ok).toBe(true)
    } finally {
      await h.dispose()
    }
  })

  it("does not shadow an entry that only carries the parent's appended rules", async () => {
    const h = await harness(withBoth, {
      agentConfigRules: [{ action: "bash", resource: "*", effect: "deny" }],
    })

    try {
      const outcome = await h.registry.refresh()
      const entries = await listing(h.fake)
      const reviewer = entries.find((entry) => entry.name === "A/reviewer")

      expect(outcome.diagnostics.filter((line) => line.startsWith("agent-shadow-audit:"))).toEqual([])
      expect((reviewer?.permissions as readonly unknown[]).slice(-1)).toEqual([
        { action: "bash", resource: "*", effect: "deny" },
      ])
    } finally {
      await h.dispose()
    }
  })

  it("registers the identical set on a second registry over the same fixture", async () => {
    const h = await harness(withBoth)
    const first = await listing(h.fake)

    try {
      const restart = fakeContext([], { directory: h.fixture.root })
      const registry = createRegistry(restart.ctx, { now: () => 0 })

      try {
        await registry.activate()
        const second = await listing(restart)

        const shape = (entries: readonly Record<string, unknown>[]) =>
          [...entries]
            .map((entry) => ({ id: String(entry.id), name: entry.name, mode: entry.mode, hidden: entry.hidden }))
            .sort((left, right) => left.id.localeCompare(right.id))

        expect(shape(second)).toEqual(shape(first))
      } finally {
        await registry.dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it("reports a failed audit read and keeps the map published", async () => {
    const fixture = await createRegistryFixture()
    await withBoth(fixture)
    const fake = fakeContext([], { directory: fixture.root })
    const registry = createRegistry(fake.ctx, { now: () => 0 })
    await registry.activate()
    fake.fail("agent.list", new Error("audit listing refused"))

    try {
      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(true)
      expect(outcome.diagnostics.filter((line) => line.startsWith("agent-audit:"))).toEqual([
        "agent-audit: audit listing refused",
      ])
      fake.clearFailures()
      expect((await listing(fake)).map((entry) => entry.name).sort()).toEqual(["A/reviewer", "A/translator"])
    } finally {
      await registry.dispose()
      await fixture.cleanup()
    }
  })
})

describe("isolation", () => {
  it("keeps skills and commands published when the agent transform rejects", async () => {
    const h = await harness(
      async (fixture) => {
        await fixture.write("A/.opencode/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy\n")
        await fixture.write("A/.opencode/command/release.md", "---\ndescription: r\n---\nrelease\n")
        await fixture.write("A/opencode.json", JSON.stringify({ agents: { reviewer: {} } }))
      },
      { activate: false },
    )
    h.fake.fail("agent.transform", new Error("transform refused"))

    try {
      const outcome = await h.registry.activate()

      expect(outcome.ok).toBe(true)
      expect(outcome.skills).toBe(1)
      expect(outcome.commands).toBe(1)
      expect(outcome.diagnostics.filter((line) => line.startsWith("agent-register:"))).toEqual([
        "agent-register: transform refused",
      ])
    } finally {
      await h.dispose()
    }
  })

  it("retries a rejected transform on the next refresh and reports the rejection once", async () => {
    const h = await harness(withBoth, { activate: false })
    h.fake.fail("agent.transform", new Error("transform refused"))

    try {
      const first = await h.registry.activate()
      expect(first.diagnostics.filter((line) => line.startsWith("agent-register:"))).toEqual([
        "agent-register: transform refused",
      ])
      expect(h.fake.agentTransforms).toHaveLength(0)
      expect(await listing(h.fake)).toEqual([])

      // Reported once per instance, and the attempt is not final: a second failed refresh
      // registers nothing new and stays silent.
      const stillFailing = await h.registry.refresh()
      expect(stillFailing.diagnostics.filter((line) => line.startsWith("agent-register:"))).toEqual([])
      expect(h.fake.agentTransforms).toHaveLength(0)
      expect(await listing(h.fake)).toEqual([])

      // The registration is retried, not abandoned: one transient host rejection must not
      // cost the instance its agents for its whole life.
      h.fake.clearFailures()
      const second = await h.registry.refresh()

      expect(second.diagnostics.filter((line) => line.startsWith("agent-register:"))).toEqual([])
      expect(h.fake.agentTransforms).toHaveLength(1)
      expect((await listing(h.fake)).map((entry) => entry.name).sort()).toEqual(["A/reviewer", "A/translator"])
    } finally {
      await h.dispose()
    }
  })

  it("names a whole-payload replay failure in the payload form, once per failing replay", async () => {
    const h = await harness(withBoth)

    try {
      // A throw outside one entry (not attributable to an ID) is the payload form; the host
      // must never see it, because a throw escaping the transform disables the plugin group.
      replayControl.payloadError = new Error("payload exploded")

      await h.registry.refresh()
      // Diagnostics raised during a replay surface in the next refresh's outcome, so the error
      // is cleared before that refresh: the reported replay is the failing one, not this one.
      replayControl.payloadError = undefined
      const surfaced = await h.registry.refresh()
      expect(surfaced.diagnostics.filter((line) => line.startsWith("agent-replay:"))).toEqual([
        "agent-replay: payload: payload exploded",
      ])
      expect(surfaced.ok).toBe(true)

      // Per failing replay, not sticky: a clean refresh reports none and registers no new transform.
      const clean = await h.registry.refresh()
      expect(clean.diagnostics.filter((line) => line.startsWith("agent-replay:"))).toEqual([])
      expect(h.fake.agentTransforms).toHaveLength(1)
    } finally {
      replayControl.payloadError = undefined
      await h.dispose()
    }
  })

  it("reports a failed seed read and still attempts the registration", async () => {
    const h = await harness(
      async (fixture) => {
        await fixture.write("A/.opencode/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy\n")
        await fixture.write("A/opencode.json", JSON.stringify({ agents: { reviewer: {} } }))
      },
      { activate: false },
    )
    h.fake.fail("agent.list", new Error("listing refused"))

    try {
      const outcome = await h.registry.activate()

      expect(outcome.ok).toBe(true)
      expect(outcome.skills).toBe(1)
      expect(outcome.diagnostics.filter((line) => line.startsWith("agent-seed:"))).toEqual([
        "agent-seed: listing refused",
      ])
      expect(h.fake.agentTransforms).toHaveLength(1)
      expect(h.registry.agents.map((agent) => agent.name)).toEqual(["reviewer"])
    } finally {
      await h.dispose()
    }
  })

  it("publishes an empty agent list and reloads once when the location disappears", async () => {
    const h = await harness(withBoth)

    try {
      expect(h.fake.agentReloadCalls).toBe(1)
      h.fake.setLocation(`${h.fixture.root}-gone`)
      const outcome = await h.registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(h.fake.agentReloadCalls).toBe(2)
      expect((await listing(h.fake)).map((entry) => entry.name)).toEqual([])
      expect(outcome.diagnostics.filter((line) => line.startsWith("agent-reload:"))).toEqual([])
    } finally {
      await h.dispose()
    }
  })
})
