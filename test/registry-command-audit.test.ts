import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { commandDoc } from "./support/command-family-fixtures.ts"
import { commandStorage, publishWorkspace, type PublishWorkspace } from "./support/command-publish-fixtures.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
import type { FamilyWorkspace } from "./support/family-fixtures.ts"

const scanControl = vi.hoisted(() => ({ scans: 0 }))

vi.mock("../src/scan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scan.ts")>()
  return {
    ...actual,
    scanSkills: async (options: Parameters<typeof actual.scanSkills>[0]) => {
      scanControl.scans += 1
      return actual.scanSkills(options)
    },
  }
})

const { createRegistry } = await import("../src/registry.ts")

const workspaces: FamilyWorkspace[] = []
const homes: string[] = []

const publish = async (relative = ""): Promise<PublishWorkspace> => {
  const created = await publishWorkspace(relative)
  workspaces.push(created)
  return created
}

const open = (
  directory: string,
  nativeCommands: readonly { readonly name: string; readonly description?: string }[] = [],
): { readonly fake: FakeContext; readonly registry: ReturnType<typeof createRegistry> } => {
  const fake = fakeContext([], { directory, nativeCommands })
  return { fake, registry: createRegistry(fake.ctx) }
}

const names = (fake: FakeContext): readonly string[] => fake.commandDefinitions.map((entry) => entry.name)

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nested-command-audit-home-"))
  homes.push(home)
  vi.stubEnv("OPENCODE_TEST_HOME", home)
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(home, ".config", "opencode"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  scanControl.scans = 0
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

describe("the post-reload command audit", () => {
  it("A1: reports a shadow a late native registration introduced", async () => {
    const ws = await publish("app")
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base, [{ name: "A:deploy", description: "native deploy" }])

    try {
      const outcome = await registry.activate()

      expect(outcome.diagnostics).toContain("native-shadow-audit: A:deploy")
      expect(outcome.diagnostics).not.toContain("native-shadow: A:deploy")
      expect(outcome.commands).toBe(1)
      expect(JSON.stringify(commandStorage(fake))).toContain("A:deploy")
    } finally {
      await registry.dispose()
    }
  })

  it("A2: the next snapshot drops a shadow the audit reported", async () => {
    const ws = await publish("app")
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base, [{ name: "A:deploy", description: "native deploy" }])

    try {
      const first = await registry.activate()
      const second = await registry.refresh()

      expect(first.diagnostics).toContain("native-shadow-audit: A:deploy")
      expect(second.commands).toBe(0)
      expect(JSON.stringify(commandStorage(fake))).not.toContain("A:deploy")
      expect((await fake.ctx.command.list()).data.map((entry) => entry.name)).toEqual(["A:deploy"])
      expect(second.diagnostics.filter((line) => line.startsWith("native-shadow-audit:"))).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it("A3: a removed native entry lets the command return two refreshes later", async () => {
    const ws = await publish("app")
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base, [{ name: "A:deploy", description: "native deploy" }])

    try {
      await registry.activate()
      const dropped = await registry.refresh()
      fake.setNativeCommands([])
      const pruning = await registry.refresh()
      const returned = await registry.refresh()

      expect(dropped.commands).toBe(0)
      expect(pruning.commands).toBe(0)
      expect(returned.commands).toBe(1)
      expect(names(fake)).toEqual(["A:deploy"])
      expect(fake.commandDefinitions[0]?.description).toBe("deploy command")
      expect(JSON.stringify(commandStorage(fake))).toContain("A:deploy")
    } finally {
      await registry.dispose()
    }
  })

  it("A5: the audit causes no second scan and no extra reload", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base, [{ name: "A:deploy", description: "native deploy" }])

    try {
      const first = await registry.activate()
      const second = await registry.refresh()

      expect(first.diagnostics).toContain("native-shadow-audit: A:deploy")
      expect(scanControl.scans).toBe(2)
      expect(fake.commandReloadCalls).toBe(2)
      expect(fake.reloadCalls).toBe(2)
      expect(second.reloads).toBe(1)
    } finally {
      await registry.dispose()
    }
  })

  it("A4b: never reports a name our snapshot never had", async () => {
    const ws = await publish("app")
    await ws.command("command", "deploy.md")
    await ws.write(".opencode/command/A:deploy.md", commandDoc("A:deploy"))
    const { fake, registry } = open(ws.base)

    try {
      const outcome = await registry.activate()

      expect(outcome.diagnostics).toContain("native-shadow: A:deploy")
      expect(outcome.diagnostics.filter((line) => line.startsWith("native-shadow-audit:"))).toEqual([])
      expect(outcome.diagnostics.filter((line) => line.startsWith("command-absent:"))).toEqual([])
      expect(names(fake)).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it("A7: a no-op rescan stays quiet and writes no command key", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      const before = JSON.stringify(commandStorage(fake))

      const second = await registry.refresh()

      expect(second.diagnostics.filter((line) => line.startsWith("native-shadow-audit:"))).toEqual([])
      expect(second.diagnostics.filter((line) => line.startsWith("command-absent:"))).toEqual([])
      expect(JSON.stringify(commandStorage(fake))).toBe(before)
      expect(fake.commandReloadCalls).toBe(2)
      expect(fake.reloadCalls).toBe(2)
    } finally {
      await registry.dispose()
    }
  })
})
