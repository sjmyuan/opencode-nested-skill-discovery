import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"
import { fakeWatch } from "./support/watch-fixtures.ts"

/**
 * F15 Step 6 (ADR agent A13, plan D7): the shared rescan covers an agent-root event, and
 * the watcher set names the agent root of a subproject that also owns skills. The registry
 * passes the pre-suppression scan list, exactly as it does for commands.
 */

const scanControl = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  gate: undefined as Promise<void> | undefined,
  scans: 0,
}))

vi.mock("../src/scan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scan.ts")>()
  return {
    ...actual,
    scanSkills: async (options: Parameters<typeof actual.scanSkills>[0]) => {
      scanControl.scans += 1
      if (scanControl.failure !== undefined) throw scanControl.failure
      if (scanControl.gate !== undefined) await scanControl.gate
      return actual.scanSkills(options)
    },
  }
})

const DOC = "---\nname: %NAME%\n---\n# %NAME%\n"
const DEBOUNCE = 5
const THROTTLE = 20

const skillDoc = (name: string): string => DOC.replaceAll("%NAME%", name)

interface Harness {
  readonly fixture: Awaited<ReturnType<typeof createRegistryFixture>>
  readonly fake: ReturnType<typeof fakeContext>
  readonly watch: ReturnType<typeof fakeWatch>
  readonly registry: ReturnType<typeof createRegistry>
  dispose(): Promise<void>
}

async function harness(): Promise<Harness> {
  const fixture = await createRegistryFixture()
  await fixture.write("A/.opencode/skills/deploy/SKILL.md", skillDoc("deploy"))
  await fixture.write("A/.opencode/agent/translator.md", "# Translator\n")
  const fake = fakeContext([], { directory: fixture.root })
  const watch = fakeWatch()
  const registry = createRegistry(fake.ctx, {
    watchDirectory: watch.factory,
    debounceMs: DEBOUNCE,
    throttleMs: THROTTLE,
    now: () => 0,
  })
  await registry.activate()

  return {
    fixture,
    fake,
    watch,
    registry,
    async dispose() {
      await registry.dispose()
      await fixture.cleanup()
    },
  }
}

beforeEach(() => {
  scanControl.failure = undefined
  scanControl.gate = undefined
  scanControl.scans = 0
})

describe("agent-root watcher coverage", () => {
  it("watches the agent root and the subproject of an agent-only span", async () => {
    const h = await harness()

    try {
      expect(h.watch.active()).toContain(`${h.fixture.realRoot}/A`)
      expect(h.watch.active()).toContain(`${h.fixture.realRoot}/A/.opencode/agent`)
      await vi.waitFor(() => expect(h.registry.outcome.ok).toBe(true), { timeout: 2000 })
      expect(h.registry.outcome.commands).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it("re-scans once for an agent-root event and keeps the fixture's skill and agent published", async () => {
    const h = await harness()

    try {
      expect(scanControl.scans).toBe(1)
      h.watch.emit(`${h.fixture.realRoot}/A/.opencode/agent`)

      await vi.waitFor(() => expect(scanControl.scans).toBe(2), { timeout: 2000 })
      expect(h.registry.outcome.ok).toBe(true)
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent"))).toEqual([])
      // The rescan republishes the same fixture, so the title's "keeps ... published" is asserted,
      // not implied by a successful outcome.
      const skills = h.registry.snapshot.snapshots.flatMap((subproject) =>
        subproject.skills.map((entry) => entry.name),
      )
      expect(skills.sort()).toEqual(["A/deploy"])
      expect((await h.fake.ctx.agent.list()).data.map((entry) => entry.name)).toEqual(["A/translator"])
    } finally {
      await h.dispose()
    }
  })
})
