import { describe, expect, it, vi } from "vitest"
import { skillTokenFor, scopeTokenFor } from "../src/indexer.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\n---\n# Deploy\n"

const pause = vi.hoisted(() => {
  let release = (): void => {}
  let settle = (): void => {}

  return {
    armed: false,
    blocked: false,
    gate: new Promise<void>((resolve) => {
      release = resolve
    }),
    released: new Promise<void>((resolve) => {
      settle = resolve
    }),
    release: (): void => release(),
    settle: (): void => settle(),
  }
})

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()

  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (!pause.armed || typeof args[0] !== "string" || !args[0].endsWith("SKILL.md")) {
        return actual.realpath(...args)
      }

      pause.armed = false
      pause.blocked = true
      await pause.gate

      try {
        return await actual.realpath(...args)
      } finally {
        pause.settle()
      }
    },
  }
})

const flushMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve()
}

const idsOf = (registry: ReturnType<typeof createRegistry>): string[] =>
  registry.snapshot.snapshots.flatMap((subproject) => subproject.skills.map((entry) => entry.id))

describe("deferred dedupe against a concurrent refresh", () => {
  it("never applies a correction computed from a replaced snapshot", async () => {
    const fixture = await createRegistryFixture()
    const globals = await createRegistryFixture()
    vi.useFakeTimers()

    try {
      await globals.write("skills/global-demo/SKILL.md", DOC)
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      const globalNative = nativeSkill(
        "global-demo",
        await globals.realpathOf("skills/global-demo/SKILL.md"),
      )
      const twin = nativeSkill(
        "native-deploy",
        await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md"),
      )
      const nestedId = `nested.${scopeTokenFor(await fixture.realpathOf("A"))}.${skillTokenFor(
        "deploy",
        twin.path as string,
      )}`
      const fake = fakeContext([globalNative, twin], { directory: fixture.root })
      fake.hideNatives(1, ["global-demo"])
      const registry = createRegistry(fake.ctx)

      const first = await registry.activate()

      expect(first.reloads).toBe(1)
      expect(idsOf(registry)).toContain(nestedId)
      expect(vi.getTimerCount()).toBe(2)

      pause.armed = true
      vi.advanceTimersByTime(1500)
      await vi.waitFor(() => expect(pause.blocked).toBe(true))

      fake.removeNative(twin.id)
      const newer = await registry.refresh()

      expect(newer.version).toBeGreaterThan(first.version ?? 0)
      expect(idsOf(registry)).toContain(nestedId)

      const reloadsBeforeRelease = fake.reloadCalls
      pause.release()
      await pause.released
      await flushMicrotasks()

      expect(idsOf(registry)).toContain(nestedId)
      expect(await fake.storage.get("nested/manifest/version")).toBe(newer.version)
      expect(fake.reloadCalls).toBe(reloadsBeforeRelease)
    } finally {
      vi.useRealTimers()
      await globals.cleanup()
      await fixture.cleanup()
    }
  })
})
