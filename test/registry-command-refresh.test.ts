import path from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { scanSkills } from "../src/scan.ts"
import { deriveWatchTargets } from "../src/watch.ts"
import { writeCommand } from "./support/command-family-fixtures.ts"
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
})
