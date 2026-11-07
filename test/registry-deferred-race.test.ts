import { realpath } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { skillTokenFor, scopeTokenFor } from "../src/indexer.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\n---\n# Deploy\n"

const pause = vi.hoisted(() => {
  let release = (): void => {}
  let settle = (): void => {}

  const state = {
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
    reset: (): void => {
      state.armed = false
      state.blocked = false
      state.gate = new Promise<void>((resolve) => {
        release = resolve
      })
      state.released = new Promise<void>((resolve) => {
        settle = resolve
      })
    },
  }

  return state
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

const waitUntil = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const idsOf = (registry: ReturnType<typeof createRegistry>): string[] =>
  registry.snapshot.snapshots.flatMap((subproject) => subproject.skills.map((entry) => entry.id))

const nestedIdFor = async (directory: string, skillPath: string): Promise<string> =>
  `nested.${scopeTokenFor(await realpath(directory))}.${skillTokenFor("deploy", await realpath(skillPath))}`

describe("deferred dedupe against a concurrent refresh", () => {
  it("never applies a correction computed from a replaced snapshot", async () => {
    pause.reset()
    const fixture = await createRegistryFixture()
    const globals = await createRegistryFixture()
    let fake: ReturnType<typeof fakeContext> | undefined
    let registry: ReturnType<typeof createRegistry> | undefined
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
      fake = fakeContext([globalNative, twin], { directory: fixture.root })
      fake.hideNatives(1, ["global-demo"])
      registry = createRegistry(fake.ctx)

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
      if (registry !== undefined) await registry.dispose()
      await globals.cleanup()
      await fixture.cleanup()
    }
  })

  it("D1: a suppression-turning refresh is never overtaken by a deferred persist", async () => {
    const fixture = await createRegistryFixture()
    const globals = await createRegistryFixture()
    let registry: ReturnType<typeof createRegistry> | undefined
    let release: () => void = () => {}
    let blocked = false

    try {
      await globals.write("skills/global-demo/SKILL.md", DOC)
      await fixture.write("main/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("wt/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("wt/.opencode/skills/tidy/SKILL.md", DOC)
      const globalNative = nativeSkill(
        "global-demo",
        await globals.realpathOf("skills/global-demo/SKILL.md"),
      )
      const twin = nativeSkill(
        "native-deploy",
        await fixture.realpathOf("wt/.opencode/skills/deploy/SKILL.md"),
      )
      const wtToken = scopeTokenFor(await fixture.realpathOf("wt"))
      const suppressedId = `nested.${wtToken}.${skillTokenFor("deploy", twin.path as string)}`
      const survivorId = await nestedIdFor(
        `${fixture.root}/main`,
        `${fixture.root}/main/.opencode/skills/deploy/SKILL.md`,
      )
      const fake = fakeContext([globalNative, twin], { directory: fixture.root })
      fake.hideNatives(1, ["global-demo"])
      registry = createRegistry(fake.ctx)

      const first = await registry.activate()

      expect(first.reloads).toBe(1)
      expect(idsOf(registry)).toHaveLength(3)

      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const storagePort = (
        fake.ctx as unknown as { storage: { set(key: string, value: unknown): Promise<void> } }
      ).storage
      const writeStorage = storagePort.set.bind(storagePort)
      const blockedKey = `nested/manifest/${wtToken}`
      storagePort.set = async (key, value) => {
        if (!blocked && key === blockedKey) {
          blocked = true
          await gate
        }
        return writeStorage(key, value)
      }

      await waitUntil(() => blocked)

      const commonDir = await fixture.mkdirp("main/.git/worktrees/linked")
      await fixture.write("wt/.git", `gitdir: ${commonDir}\n`)
      fake.removeNative(twin.id)

      const refreshing = registry.refresh()
      await Promise.race([refreshing, new Promise<void>((resolve) => setTimeout(resolve, 250))])

      release()
      const newer = await refreshing
      await flushMicrotasks()

      expect(newer.reloads).toBe(1)
      expect([...idsOf(registry)].sort()).toEqual([survivorId])
      expect(idsOf(registry)).not.toContain(suppressedId)
      expect(
        fake.editor
          .list()
          .map((entry) => String(entry.id))
          .filter((id) => id.startsWith("nested.")),
      ).toEqual([survivorId])
      expect(fake.storage.has(`nested/manifest/${wtToken}`)).toBe(false)
      expect(fake.storage.has(`nested/subproject/${wtToken}`)).toBe(false)
      expect(await fake.storage.get("nested/manifest/version")).toBe(newer.version)
    } finally {
      if (registry !== undefined) await registry.dispose()
      await globals.cleanup()
      await fixture.cleanup()
    }
  })

  it("D2: a deferred correction committed first is superseded by the refresh that follows", async () => {
    pause.reset()
    const fixture = await createRegistryFixture()
    const globals = await createRegistryFixture()
    let fake: ReturnType<typeof fakeContext> | undefined
    let registry: ReturnType<typeof createRegistry> | undefined
    vi.useFakeTimers()

    try {
      await globals.write("skills/global-demo/SKILL.md", DOC)
      await fixture.write("main/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("wt/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("wt/.opencode/skills/tidy/SKILL.md", DOC)
      const globalNative = nativeSkill(
        "global-demo",
        await globals.realpathOf("skills/global-demo/SKILL.md"),
      )
      const twin = nativeSkill(
        "native-deploy",
        await fixture.realpathOf("wt/.opencode/skills/deploy/SKILL.md"),
      )
      const wtToken = scopeTokenFor(await fixture.realpathOf("wt"))
      const survivorId = await nestedIdFor(
        `${fixture.root}/main`,
        `${fixture.root}/main/.opencode/skills/deploy/SKILL.md`,
      )
      fake = fakeContext([globalNative, twin], { directory: fixture.root })
      fake.hideNatives(1, ["global-demo"])
      const active = createRegistry(fake.ctx)
      registry = active

      const first = await active.activate()

      expect(first.reloads).toBe(1)

      await vi.advanceTimersByTimeAsync(1500)
      await vi.waitFor(() => expect(idsOf(active)).toHaveLength(2))

      expect(idsOf(registry)).toHaveLength(2)
      expect(fake.storage.has(`nested/manifest/${wtToken}`)).toBe(true)

      fake.removeNative(twin.id)
      const commonDir = await fixture.mkdirp("main/.git/worktrees/linked")
      await fixture.write("wt/.git", `gitdir: ${commonDir}\n`)
      const newer = await active.refresh()

      expect(newer.reloads).toBe(1)
      expect([...idsOf(active)].sort()).toEqual([survivorId])
      expect(fake.storage.has(`nested/manifest/${wtToken}`)).toBe(false)
      expect(fake.storage.has(`nested/subproject/${wtToken}`)).toBe(false)
      expect(await fake.storage.get("nested/manifest/version")).toBe(newer.version)
    } finally {
      vi.useRealTimers()
      if (registry !== undefined) await registry.dispose()
      await globals.cleanup()
      await fixture.cleanup()
    }
  })

  it("D3: a queued refresh observes the deferred swap inside the write gate", async () => {
    pause.reset()
    const fixture = await createRegistryFixture()
    const globals = await createRegistryFixture()
    let registry: ReturnType<typeof createRegistry> | undefined
    let release: () => void = () => {}
    let blocked = false
    let captured: string[] | undefined

    try {
      await globals.write("skills/global-demo/SKILL.md", DOC)
      await fixture.write("main/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("wt/.opencode/skills/deploy/SKILL.md", DOC)
      await fixture.write("wt/.opencode/skills/tidy/SKILL.md", DOC)
      const globalNative = nativeSkill(
        "global-demo",
        await globals.realpathOf("skills/global-demo/SKILL.md"),
      )
      const twin = nativeSkill(
        "native-deploy",
        await fixture.realpathOf("wt/.opencode/skills/deploy/SKILL.md"),
      )
      const wtToken = scopeTokenFor(await fixture.realpathOf("wt"))
      const mainDeployId = await nestedIdFor(
        `${fixture.root}/main`,
        `${fixture.root}/main/.opencode/skills/deploy/SKILL.md`,
      )
      const wtTidyId = `nested.${wtToken}.${skillTokenFor(
        "tidy",
        await fixture.realpathOf("wt/.opencode/skills/tidy/SKILL.md"),
      )}`
      const suppressedId = `nested.${wtToken}.${skillTokenFor("deploy", twin.path as string)}`
      const fake = fakeContext([globalNative, twin], { directory: fixture.root })
      fake.hideNatives(1, ["global-demo"])
      const active = createRegistry(fake.ctx)
      registry = active

      const first = await active.activate()

      expect(first.reloads).toBe(1)
      expect(idsOf(active)).toHaveLength(3)

      // The deferred pass pauses inside persistRegistry with the write gate held.
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const storagePort = (
        fake.ctx as unknown as {
          storage: {
            get(key: string): Promise<unknown>
            set(key: string, value: unknown): Promise<void>
          }
        }
      ).storage
      const readStorage = storagePort.get.bind(storagePort)
      const writeStorage = storagePort.set.bind(storagePort)
      const blockedKey = `nested/manifest/${wtToken}`
      storagePort.set = async (key, value) => {
        if (!blocked && key === blockedKey) {
          blocked = true
          await gate
        }
        return writeStorage(key, value)
      }
      // DD1: capture at the refresh's first storage access — the version read that
      // persistRegistry performs before its first set.
      storagePort.get = async (key) => {
        if (blocked && captured === undefined && key === "nested/manifest/version") {
          captured = [...idsOf(active)]
        }
        return readStorage(key)
      }

      await waitUntil(() => blocked)

      const commonDir = await fixture.mkdirp("main/.git/worktrees/linked")
      await fixture.write("wt/.git", `gitdir: ${commonDir}\n`)
      fake.removeNative(twin.id)

      const refreshing = active.refresh()
      await Promise.race([refreshing, new Promise<void>((resolve) => setTimeout(resolve, 250))])

      release()
      const newer = await refreshing
      await flushMicrotasks()

      expect(captured).toBeDefined()
      expect([...(captured ?? [])].sort()).toEqual([mainDeployId, wtTidyId].sort())
      expect(captured).not.toContain(suppressedId)
      expect(newer.reloads).toBe(1)
      expect([...idsOf(active)].sort()).toEqual([mainDeployId])
      expect(fake.storage.has(blockedKey)).toBe(false)
    } finally {
      if (registry !== undefined) await registry.dispose()
      await globals.cleanup()
      await fixture.cleanup()
    }
  })
})
