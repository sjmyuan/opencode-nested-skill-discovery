import { rm } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { scanSkills } from "../src/scan.ts"
import { deriveWatchTargets } from "../src/watch.ts"
import { writeCommand } from "./support/command-family-fixtures.ts"
import { commandStorage } from "./support/command-publish-fixtures.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"
import { fakeWatch } from "./support/watch-fixtures.ts"

const scanControl = vi.hoisted(() => ({ failure: undefined as Error | undefined, scans: 0 }))

vi.mock("../src/scan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scan.ts")>()
  return {
    ...actual,
    scanSkills: async (options: Parameters<typeof actual.scanSkills>[0]) => {
      scanControl.scans += 1
      if (scanControl.failure !== undefined) throw scanControl.failure
      return actual.scanSkills(options)
    },
  }
})

const DEBOUNCE = 5
const THROTTLE = 20

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const workspaces: FamilyWorkspace[] = []

interface Harness {
  readonly ws: FamilyWorkspace
  readonly fake: FakeContext
  readonly watch: ReturnType<typeof fakeWatch>
  readonly registry: ReturnType<typeof createRegistry>
  readonly clock: { at: number }
  dispose(): Promise<void>
}

async function harness(prepare?: (ws: FamilyWorkspace) => Promise<void>): Promise<Harness> {
  const ws = await createFamilyWorkspace()
  workspaces.push(ws)
  if (prepare !== undefined) await prepare(ws)
  const fake = fakeContext([], { directory: ws.root })
  const watch = fakeWatch()
  const clock = { at: 0 }
  const registry = createRegistry(fake.ctx, {
    watchDirectory: watch.factory,
    debounceMs: DEBOUNCE,
    throttleMs: THROTTLE,
    now: () => clock.at,
  })
  await registry.activate()

  return { ws, fake, watch, registry, clock, dispose: () => registry.dispose() }
}

const defined = (fake: FakeContext): readonly string[] => fake.commandDefinitions.map((entry) => entry.name)

const at = (ws: FamilyWorkspace, relative: string): string => path.join(ws.root, relative)

beforeEach(() => {
  scanControl.failure = undefined
  scanControl.scans = 0
})

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

describe("command refresh lifecycle", () => {
  it("watches every command root, command directory, and subproject of the last scan", async () => {
    const h = await harness(async (ws) => {
      await ws.repo("A")
      await writeCommand(ws, "A", "command", "deploy.md")
    })

    try {
      const scanned = await scanSkills({ location: h.ws.root })
      const expected = await deriveWatchTargets({
        location: h.ws.root,
        candidates: scanned.candidates,
        commands: scanned.commands,
      })

      expect(h.watch.active()).toEqual([...expected.targets])
      expect(h.watch.active()).toContain(at(h.ws, "A/.opencode/command"))
      expect(h.watch.active()).not.toContain(at(h.ws, "A/.git"))
    } finally {
      await h.dispose()
    }
  })

  it("publishes an added command file within the debounce window", async () => {
    const h = await harness(async (ws) => {
      await writeCommand(ws, "A", "command", "deploy.md")
    })

    try {
      expect(defined(h.fake)).toEqual(["A:deploy"])

      await writeCommand(h.ws, "A", "command", "release.md")
      h.watch.emit(at(h.ws, "A/.opencode/command"))

      await vi.waitFor(() => expect(defined(h.fake)).toContain("A:release"), { timeout: 2000 })
    } finally {
      await h.dispose()
    }
  })

  it("republishes an edited command file's description within the debounce window", async () => {
    const h = await harness(async (ws) => {
      await writeCommand(ws, "A", "command", "deploy.md")
    })

    try {
      expect(h.fake.commandDefinitions[0]?.description).toBe("deploy command")

      await h.ws.write(
        "A/.opencode/command/deploy.md",
        "---\ndescription: a rewritten description\n---\n# deploy\n\nnew body.\n",
      )
      h.watch.emit(at(h.ws, "A/.opencode/command"))

      await vi.waitFor(
        () => expect(h.fake.commandDefinitions[0]?.description).toBe("a rewritten description"),
        { timeout: 2000 },
      )
      expect(defined(h.fake)).toEqual(["A:deploy"])
    } finally {
      await h.dispose()
    }
  })

  it("deleting the last command in a subproject omits the name with exactly one reload", async () => {
    const h = await harness(async (ws) => {
      await writeCommand(ws, "A", "command", "deploy.md")
    })

    try {
      const reloads = h.fake.commandReloadCalls
      expect(defined(h.fake)).toEqual(["A:deploy"])

      await rm(at(h.ws, "A/.opencode/command/deploy.md"))
      h.watch.emit(at(h.ws, "A/.opencode/command"))

      await vi.waitFor(() => expect(defined(h.fake)).toEqual([]), { timeout: 2000 })
      expect(h.fake.commandReloadCalls).toBe(reloads + 1)
      expect(JSON.stringify(commandStorage(h.fake))).not.toContain("A:deploy")
    } finally {
      await h.dispose()
    }
  })

  it("runs exactly one scan and one command reload for one event burst", async () => {
    const h = await harness(async (ws) => {
      await writeCommand(ws, "A", "command", "deploy.md")
    })

    try {
      const scans = scanControl.scans
      const reloads = h.fake.commandReloadCalls

      await writeCommand(h.ws, "A", "command", "release.md")
      for (let index = 0; index < 5; index += 1) h.watch.emit(at(h.ws, "A/.opencode/command"))

      await vi.waitFor(() => expect(defined(h.fake)).toContain("A:release"), { timeout: 2000 })
      await sleep(DEBOUNCE * 4)

      expect(scanControl.scans).toBe(scans + 1)
      expect(h.fake.commandReloadCalls).toBe(reloads + 1)
    } finally {
      await h.dispose()
    }
  })

  it("keeps a no-op watcher refresh quiet: identical command keys, no new command diagnostic, no handle churn", async () => {
    const h = await harness(async (ws) => {
      await writeCommand(ws, "A", "command", "deploy.md")
    })

    try {
      const bytes = JSON.stringify(commandStorage(h.fake))
      const scans = scanControl.scans
      const reloads = h.fake.reloadCalls
      const opened = [...h.watch.opened]

      h.watch.emit(at(h.ws, "A/.opencode/command"))

      await vi.waitFor(() => expect(h.fake.reloadCalls).toBe(reloads + 1), { timeout: 2000 })

      expect(scanControl.scans).toBe(scans + 1)
      expect(JSON.stringify(commandStorage(h.fake))).toBe(bytes)
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("command-"))).toEqual([])
      expect(h.watch.opened).toEqual(opened)
      expect(h.watch.closed).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("adds a new subproject's command root from the location root watcher", async () => {
    const h = await harness(async (ws) => {
      await writeCommand(ws, "A", "command", "deploy.md")
    })

    try {
      await writeCommand(h.ws, "C", "command", "deploy.md")
      h.watch.emit(h.ws.root)

      await vi.waitFor(() => expect(defined(h.fake)).toContain("C:deploy"), { timeout: 2000 })
      expect(h.watch.active()).toContain(at(h.ws, "C/.opencode/command"))
    } finally {
      await h.dispose()
    }
  })

  it("closes the handle of a command root deleted with its last file", async () => {
    const h = await harness(async (ws) => {
      await writeCommand(ws, "A", "command", "deploy.md")
    })
    const root = at(h.ws, "A/.opencode/command")

    try {
      expect(h.watch.active()).toContain(root)

      await rm(root, { recursive: true, force: true })
      h.watch.emit(root)

      await vi.waitFor(() => expect(defined(h.fake)).toEqual([]), { timeout: 2000 })
      expect(h.watch.active()).not.toContain(root)
      expect(h.watch.closed).toContain(root)
    } finally {
      await h.dispose()
    }
  })
})
