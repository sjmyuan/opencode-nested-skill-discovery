import { rm } from "node:fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { scanSkills } from "../src/scan.ts"
import { setup } from "../src/plugin.ts"
import { deriveWatchTargets } from "../src/watch.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"
import { fakeWatch } from "./support/watch-fixtures.ts"

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
  readonly fixture: Awaited<ReturnType<typeof createRegistryFixture>>
  readonly fake: ReturnType<typeof fakeContext>
  readonly watch: ReturnType<typeof fakeWatch>
  readonly registry: ReturnType<typeof createRegistry>
  readonly clock: { at: number }
  dispose(): Promise<void>
}

async function harness(): Promise<Harness> {
  const fixture = await createRegistryFixture()
  await fixture.write("A/.opencode/skills/deploy/SKILL.md", skillDoc("deploy"))
  const fake = fakeContext([], { directory: fixture.root })
  const watch = fakeWatch()
  const clock = { at: 0 }
  const registry = createRegistry(fake.ctx, {
    watchDirectory: watch.factory,
    debounceMs: DEBOUNCE,
    throttleMs: THROTTLE,
    now: () => clock.at,
  })
  await registry.activate()

  return {
    fixture,
    fake,
    watch,
    registry,
    clock,
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

describe("watcher-triggered refresh", () => {
  it("watches exactly the directories the scan derived", async () => {
    const h = await harness()

    try {
      const scanned = await scanSkills({ location: h.fixture.realRoot })
      const expected = await deriveWatchTargets({
        location: h.fixture.realRoot,
        candidates: scanned.candidates,
      })

      expect(h.watch.active()).toEqual([...expected.targets])
      expect(h.watch.active()).toContain(h.fixture.realRoot)
      expect(h.watch.active()).toContain(`${h.fixture.realRoot}/A/.opencode/skills/deploy`)
    } finally {
      await h.dispose()
    }
  })

  it("collapses a burst of events into one refresh", async () => {
    const h = await harness()

    try {
      for (let index = 0; index < 5; index += 1) h.watch.emit()

      await vi.waitFor(() => expect(h.fake.reloadCalls).toBe(2), { timeout: 2000 })
      await sleep(DEBOUNCE * 4)
      expect(h.fake.reloadCalls).toBe(2)
    } finally {
      await h.dispose()
    }
  })

  it("re-scans the whole location, so a new skill appears next to the old one", async () => {
    const h = await harness()

    try {
      await h.fixture.write("A/.opencode/skills/extra/SKILL.md", skillDoc("extra"))
      h.watch.emit(`${h.fixture.realRoot}/A/.opencode/skills`)

      await vi.waitFor(() => expect(h.registry.outcome.skills).toBe(2), { timeout: 2000 })
      const names = h.registry.snapshot.snapshots.flatMap((subproject) =>
        subproject.skills.map((entry) => entry.name),
      )
      expect(names.sort()).toEqual(["A/deploy", "A/extra"])
    } finally {
      await h.dispose()
    }
  })

  it("drops a removed skill and closes its watcher", async () => {
    const h = await harness()
    const removed = `${h.fixture.realRoot}/A/.opencode/skills/deploy`

    try {
      expect(h.watch.active()).toContain(removed)
      await rm(removed, { recursive: true, force: true })
      h.watch.emit(`${h.fixture.realRoot}/A/.opencode/skills/deploy`)

      await vi.waitFor(() => expect(h.registry.outcome.skills).toBe(0), { timeout: 2000 })
      expect(h.watch.active()).not.toContain(removed)
    } finally {
      await h.dispose()
    }
  })

  it("picks up a new subproject from the root watcher", async () => {
    const h = await harness()

    try {
      await h.fixture.write("C/.opencode/skills/deploy/SKILL.md", skillDoc("deploy"))
      h.watch.emit(h.fixture.realRoot)

      await vi.waitFor(() => expect(h.registry.outcome.subprojects).toBe(2), { timeout: 2000 })
      expect(h.watch.active()).toContain(`${h.fixture.realRoot}/C/.opencode/skills`)
    } finally {
      await h.dispose()
    }
  })

  it("keeps the snapshot and the watcher set when the scan fails, then recovers", async () => {
    const h = await harness()

    try {
      const stable = h.registry.snapshot
      const watching = h.watch.active()
      scanControl.failure = new Error("scan down")

      h.watch.emit()
      await vi.waitFor(() => expect(h.registry.outcome.ok).toBe(false), { timeout: 2000 })

      expect(h.registry.snapshot).toBe(stable)
      expect(h.watch.active()).toEqual(watching)
      expect(h.watch.closed).toEqual([])

      scanControl.failure = undefined
      const reloads = h.fake.reloadCalls
      h.watch.emit()

      await vi.waitFor(() => expect(h.fake.reloadCalls).toBe(reloads + 1), { timeout: 2000 })
    } finally {
      await h.dispose()
    }
  })

  it("runs exactly one follow-up for an event raised during an in-flight refresh", async () => {
    const h = await harness()

    try {
      let release = (): void => undefined
      scanControl.gate = new Promise<void>((resolve) => {
        release = resolve
      })

      h.watch.emit()
      await vi.waitFor(() => expect(scanControl.scans).toBe(2), { timeout: 2000 })
      h.watch.emit()
      await sleep(DEBOUNCE * 4)
      release()
      scanControl.gate = undefined

      await vi.waitFor(() => expect(h.fake.reloadCalls).toBe(3), { timeout: 2000 })
      await sleep(DEBOUNCE * 4)
      expect(h.fake.reloadCalls).toBe(3)
    } finally {
      await h.dispose()
    }
  })
})

describe("prompt backstop", () => {
  it("registers one prompt hook and suppresses the prompt right after activation", async () => {
    const h = await harness()

    try {
      expect(h.fake.hookRegistrations).toBe(1)
      const reloads = h.fake.reloadCalls

      await h.fake.firePrompt()

      expect(h.fake.reloadCalls).toBe(reloads)
      expect(h.registry.outcome.reloads).toBeGreaterThan(0)
    } finally {
      await h.dispose()
    }
  })

  it("refreshes once per throttle window", async () => {
    const h = await harness()

    try {
      const start = h.fake.reloadCalls
      h.clock.at += THROTTLE
      await h.fake.firePrompt()
      expect(h.fake.reloadCalls).toBe(start + 1)

      await h.fake.firePrompt()
      expect(h.fake.reloadCalls).toBe(start + 1)

      h.clock.at += THROTTLE
      await h.fake.firePrompt()
      expect(h.fake.reloadCalls).toBe(start + 2)
    } finally {
      await h.dispose()
    }
  })

  it("waits for the in-flight refresh instead of starting a second scan", async () => {
    const h = await harness()

    try {
      let release = (): void => undefined
      scanControl.gate = new Promise<void>((resolve) => {
        release = resolve
      })

      h.watch.emit()
      await vi.waitFor(() => expect(scanControl.scans).toBe(2), { timeout: 2000 })
      h.clock.at += THROTTLE
      const prompt = h.fake.firePrompt()
      await sleep(DEBOUNCE)
      release()
      scanControl.gate = undefined

      await expect(prompt).resolves.toBeUndefined()
      await vi.waitFor(() => expect(h.fake.reloadCalls).toBe(2), { timeout: 2000 })
      await sleep(DEBOUNCE * 4)
      expect(h.fake.reloadCalls).toBe(2)
      expect(scanControl.scans).toBe(2)
    } finally {
      await h.dispose()
    }
  })

  it("resolves a failing prompt refresh and keeps the previous snapshot", async () => {
    const h = await harness()

    try {
      const stable = h.registry.snapshot
      scanControl.failure = new Error("scan down")
      h.clock.at += THROTTLE

      await expect(h.fake.firePrompt()).resolves.toBeUndefined()

      expect(h.registry.snapshot).toBe(stable)
      expect(h.fake.reloadCalls).toBe(1)
    } finally {
      await h.dispose()
    }
  })

  it("survives a rejecting hook registration and reports it on the next refresh", async () => {
    const fixture = await createRegistryFixture()
    await fixture.write("A/.opencode/skills/deploy/SKILL.md", skillDoc("deploy"))
    const fake = fakeContext([], { directory: fixture.root })
    fake.fail("session.hook", new Error("hooks down"))
    const watch = fakeWatch()
    const registry = createRegistry(fake.ctx, { watchDirectory: watch.factory, debounceMs: DEBOUNCE })

    try {
      const outcome = await registry.activate()

      expect(outcome.ok).toBe(true)
      expect(fake.hookRegistrations).toBe(0)

      const next = await registry.refresh()

      expect(next.diagnostics).toContain("hook: hooks down")
    } finally {
      await registry.dispose()
      await fixture.cleanup()
    }
  })

  it("keeps setup resolving when the hook registration rejects", async () => {
    const fixture = await createRegistryFixture()
    await fixture.write("A/.opencode/skills/deploy/SKILL.md", skillDoc("deploy"))
    const fake = fakeContext([], { directory: fixture.root })
    fake.fail("session.hook", new Error("hooks down"))

    try {
      const cleanup = await setup(fake.ctx)

      expect(cleanup).toBeTypeOf("function")
      if (typeof cleanup === "function") await cleanup()
      expect(fake.disposeCalls).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("disposes the hook, the timers, and the watchers exactly once", async () => {
    vi.useFakeTimers()
    const fixture = await createRegistryFixture()
    await fixture.write("A/.opencode/skills/deploy/SKILL.md", skillDoc("deploy"))
    const fake = fakeContext([], { directory: fixture.root })
    const watch = fakeWatch()
    const registry = createRegistry(fake.ctx, {
      watchDirectory: watch.factory,
      debounceMs: 250,
      throttleMs: THROTTLE,
      now: () => 0,
    })

    try {
      await registry.activate()
      watch.emit()
      expect(vi.getTimerCount()).toBe(1)

      await registry.dispose()

      expect(vi.getTimerCount()).toBe(0)
      expect(fake.hookDisposeCalls).toBe(1)
      expect(fake.transforms).toHaveLength(1)
      expect(watch.active()).toEqual([])

      const reloads = fake.reloadCalls
      await fake.firePrompt()
      expect(fake.reloadCalls).toBe(reloads)

      await expect(registry.dispose()).resolves.toBeUndefined()
      expect(fake.hookDisposeCalls).toBe(1)
    } finally {
      vi.useRealTimers()
      await fixture.cleanup()
    }
  })
})
