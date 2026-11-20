import { describe, expect, it } from "vitest"
import type { Permission } from "@opencode/schema/permission"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"

/**
 * F18 conformance, fixtures 2 (ADR agent G5–G7, A14; C4): the published ruleset orders the
 * subproject's top-level rules before the agent's own and leaves the host-appended location
 * rules last, the `request` overlay never touches `settings`, and untrusted text reaches
 * `Agent.Info` sanitized.
 *
 * What the ordering case does NOT prove: that the pin's `evaluate` honours the last match.
 * That is `agents/authority-order#c3`/`#c4` read at `caf8d6a554`; this fixture proves the
 * array the plugin publishes, which is the only part the plugin controls.
 */

interface Harness {
  readonly fixture: RegistryFixture
  readonly fake: FakeContext
  readonly registry: ReturnType<typeof createRegistry>
  dispose(): Promise<void>
}

interface HarnessOptions {
  /** The location's rules, which the host's config plugin appends after every transform. */
  readonly locationRules?: readonly Permission.Rule[]
}

async function harness(
  seed: (fixture: RegistryFixture) => Promise<void>,
  options: HarnessOptions = {},
): Promise<Harness> {
  const fixture = await createRegistryFixture()
  await seed(fixture)
  const fake = fakeContext([], {
    directory: fixture.root,
    ...(options.locationRules === undefined ? {} : { agentConfigRules: options.locationRules }),
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

const entry = async (fake: FakeContext): Promise<Record<string, unknown>> => {
  const listed = (await fake.ctx.agent.list()).data as readonly Record<string, unknown>[]
  expect(listed).toHaveLength(1)
  return listed[0] as Record<string, unknown>
}

const shape = (rules: readonly Permission.Rule[]): readonly string[] =>
  rules.map((rule) => `${rule.action}:${rule.resource}:${rule.effect}`)

/** `Agent.Info.default` supplies these four rules on the insert (`agents/registration#c2`). */
const SEED = ["*:*:allow", "read:*.env:ask", "read:*.env.*:ask", "read:*.env.example:allow"]

describe("authority order", () => {
  it("runs subproject rules, then the agent's own, then the location's, in both precedence directions", async () => {
    const h = await harness(
      async (fixture) => {
        await fixture.write(
          "A/opencode.json",
          JSON.stringify({
            // The subproject's own rules: a shell deny and a read allow.
            permissions: [
              { action: "shell", resource: "*", effect: "deny" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            agents: {
              narrow: {
                description: "d",
                mode: "subagent",
                // The agent's own narrowing: a shell allow and a read deny.
                permissions: [
                  { action: "shell", resource: "*", effect: "allow" },
                  { action: "read", resource: "*", effect: "deny" },
                ],
              },
            },
          }),
        )
      },
      {
        locationRules: [
          { action: "bash", resource: "*", effect: "deny" },
          { action: "webfetch", resource: "*", effect: "deny" },
        ],
      },
    )

    try {
      const published = await entry(h.fake)
      const rules = shape(published.permissions as readonly Permission.Rule[])

      // Both directions at once: the nested shell allow and read deny sit after the
      // subproject's deny/allow, and the location's rules sit after both — so a parent
      // deny beats a nested allow and a parent allow beats a nested deny
      // (`agents/authority-order#c3`, `agents/authority-order#c4`).
      expect(rules).toEqual([
        ...SEED,
        "shell:*:deny",
        "read:*:allow",
        "shell:*:allow",
        "read:*:deny",
        "bash:*:deny",
        "webfetch:*:deny",
      ])
    } finally {
      await h.dispose()
    }
  })
})

describe("request overlay", () => {
  it("publishes headers and body key by key with settings untouched, and names the overlay once", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({
          agents: {
            overlay: {
              description: "d",
              mode: "subagent",
              request: {
                headers: { "x-a": "1", "x-b": "2" },
                body: { temperature: 0.1, top_p: 0.9 },
              },
            },
          },
        }),
      )
    })

    try {
      const published = await entry(h.fake)

      // `settings` belongs to the host's provider config, not the overlay: the plugin never
      // writes it (`agents/authority-order#c5`, `packages/schema/src/provider.ts:103-108`).
      expect(published.request).toEqual({
        settings: {},
        headers: { "x-a": "1", "x-b": "2" },
        body: { temperature: 0.1, top_p: 0.9 },
      })
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-request:"))).toEqual([
        `agent-request: ${String(published.id)}`,
      ])
    } finally {
      await h.dispose()
    }
  })
})

describe("sanitization", () => {
  it("publishes the sanitized name and description, never raw markup or a newline", async () => {
    const tail = "z".repeat(600)
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({
          agents: {
            "<b>writer</b>": {
              description: `<b>Bold</b> "quoted"\nnext line${tail}`,
              mode: "subagent",
            },
          },
        }),
      )
    })

    try {
      const published = await entry(h.fake)
      const description = String(published.description)

      // The subagent tool renders the description verbatim into a model-visible list
      // (`agents/exposure#c2`), so markup, quotes and control characters must be gone before
      // the value can enter `Agent.Info`.
      expect(published.name).toBe("A/bwriter/b")
      expect(description).toBe(`bBold/b quoted next line${tail}`.slice(0, 500))
      expect(description).not.toMatch(/[<>"\n\r\t]/)
      expect(Array.from(description)).toHaveLength(500)
      expect(String(published.name)).not.toMatch(/[<>"]/)
    } finally {
      await h.dispose()
    }
  })
})
