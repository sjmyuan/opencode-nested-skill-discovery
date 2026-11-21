import { describe, expect, it } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
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

async function harness(seed: (fixture: RegistryFixture) => Promise<void>): Promise<Harness> {
  const fixture = await createRegistryFixture()
  await seed(fixture)
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

/** The id shape every case must leave alone: `nested.<scopeToken>.<agentToken>`. */
const expectNestedId = (value: unknown): void => {
  expect(String(value)).toMatch(/^nested\.[a-z0-9-]+\.[a-z0-9-]+$/)
}

describe("authored mode", () => {
  it("publishes all so the host can offer the agent in both surfaces", async () => {
    const h = await harness(oneAgent({ description: "d", mode: "all" }))

    try {
      const published = await entry(h.fake)
      expect(published.mode).toBe("all")
      expect(published.hidden).toBe(false)
      expect(published.name).toBe("A/writer")
      expectNestedId(published.id)
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
      expectNestedId(published.id)
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
      expectNestedId(published.id)
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
      expectNestedId(published.id)
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
