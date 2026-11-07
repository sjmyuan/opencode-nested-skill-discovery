import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { commandDoc, writeCommand } from "./support/command-family-fixtures.ts"
import {
  commandStorage,
  isCommandKey,
  isSkillKey,
  publishWorkspace,
  recordStorage,
  skillSignature,
  type PublishWorkspace,
} from "./support/command-publish-fixtures.ts"
import { fakeContext, type FakeContext } from "./support/fake-context.ts"
import { checkoutSkill, createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

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

const nativeControl = vi.hoisted(() => ({ failure: undefined as Error | undefined }))

vi.mock("../src/command-native.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/command-native.ts")>()
  return {
    ...actual,
    resolveNativeCommandNames: async (...args: Parameters<typeof actual.resolveNativeCommandNames>) => {
      if (nativeControl.failure !== undefined) throw nativeControl.failure
      return actual.resolveNativeCommandNames(...args)
    },
  }
})

const manifestControl = vi.hoisted(() => ({ failure: undefined as Error | undefined }))

vi.mock("../src/manifest.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/manifest.ts")>()
  return {
    ...actual,
    persistRegistry: async (...args: Parameters<typeof actual.persistRegistry>) => {
      if (manifestControl.failure !== undefined) throw manifestControl.failure
      return actual.persistRegistry(...args)
    },
  }
})

const { STORAGE_KEYS } = await import("../src/contracts.ts")
const { createRegistry } = await import("../src/registry.ts")

const workspaces: FamilyWorkspace[] = []
const homes: string[] = []

const workspace = async (): Promise<FamilyWorkspace> => {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

const publish = async (relative = ""): Promise<PublishWorkspace> => {
  const created = await publishWorkspace(relative)
  workspaces.push(created)
  return created
}

const open = (directory: string): { readonly fake: FakeContext; readonly registry: ReturnType<typeof createRegistry> } => {
  const fake = fakeContext([], { directory })
  return { fake, registry: createRegistry(fake.ctx) }
}

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nested-command-publish-home-"))
  homes.push(home)
  vi.stubEnv("OPENCODE_TEST_HOME", home)
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(home, ".config", "opencode"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  scanControl.failure = undefined
  nativeControl.failure = undefined
  manifestControl.failure = undefined
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const names = (fake: FakeContext): readonly string[] => fake.commandDefinitions.map((entry) => entry.name)

describe("command publication from the refresh", () => {
  it("R1: a scan publishes every qualified command and lists it", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      const outcome = await registry.activate()
      const defined = fake.commandDefinitions[0]

      expect(names(fake)).toEqual(["A:deploy"])
      expect(defined?.description).toBe("deploy command")
      expect(typeof defined?.execute).toBe("function")
      expect(outcome.commands).toBe(1)
      expect(outcome.commandReloads).toBe(1)

      const listed = await fake.ctx.command.list()
      expect(listed.data.map((entry) => entry.name)).toEqual(["A:deploy"])
    } finally {
      await registry.dispose()
    }
  })

  it("R2: the command transform is registered once before the first refresh and disposed once", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      expect(fake.commandTransforms).toHaveLength(1)

      await registry.refresh()
      expect(fake.commandTransforms).toHaveLength(1)

      await registry.dispose()
      expect(fake.commandDisposeCalls).toBe(1)
    } finally {
      await registry.dispose()
    }
  })

  it("R3: deleting the command file removes the name at the next refresh", async () => {
    const ws = await publish()
    const file = await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      expect(names(fake)).toEqual(["A:deploy"])

      await rm(file)
      const outcome = await registry.refresh()

      expect(names(fake)).toEqual([])
      expect(outcome.commands).toBe(0)
      expect(fake.commandReloadCalls).toBe(2)
      expect(JSON.stringify(commandStorage(fake))).not.toContain("A:deploy")
    } finally {
      await registry.dispose()
    }
  })

  it("R4: a suppressed checkout publishes no command and reports the family line", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    for (const checkout of ["main", "wt"]) {
      await checkoutSkill(ws, checkout, "checkout")
      await writeCommand(ws, checkout, "command", "deploy.md")
    }
    const { fake, registry } = open(ws.root)

    try {
      const outcome = await registry.activate()

      expect(names(fake)).toEqual(["main:deploy"])
      expect(
        outcome.diagnostics.filter(
          (line) => line.startsWith("family: suppressed") && line.includes("/command/"),
        ),
      ).toHaveLength(1)
    } finally {
      await registry.dispose()
    }
  })

  it("R5: a native name containing a colon suppresses the composed name before publication", async () => {
    const ws = await publish("app")
    await ws.command("command", "deploy.md")
    await ws.write(".opencode/command/A:deploy.md", commandDoc("A:deploy"))
    const { fake, registry } = open(ws.base)

    try {
      const outcome = await registry.activate()

      expect(names(fake)).toEqual([])
      expect(outcome.diagnostics).toContain("native-shadow: A:deploy")
      expect(JSON.stringify(commandStorage(fake))).not.toContain("A:deploy")
    } finally {
      await registry.dispose()
    }
  })

  it("R6: a no-op rescan re-registers once, writes no command key and repeats no diagnostic", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      const before = JSON.stringify(commandStorage(fake))

      const second = await registry.refresh()

      expect(JSON.stringify(commandStorage(fake))).toBe(before)
      expect(fake.commandReloadCalls).toBe(2)
      expect(second.diagnostics.filter((line) => line.startsWith("command-"))).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it("R7: exactly one command reload per successful refresh", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      expect(fake.commandReloadCalls).toBe(1)

      await registry.refresh()
      expect(fake.commandReloadCalls).toBe(2)
    } finally {
      await registry.dispose()
    }
  })

  it("R8: a failed scan keeps the previous commands and adds no command reload", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      const reloads = fake.commandReloadCalls

      scanControl.failure = new Error("scan down")
      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(names(fake)).toEqual(["A:deploy"])
      expect(fake.commandReloadCalls).toBe(reloads)
    } finally {
      await registry.dispose()
    }
  })

  it("R9: a command persist failure keeps the previous snapshot and still reloads skills", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      await ws.command("command", "release.md")
      const skillReloads = fake.reloadCalls
      fake.failKey(STORAGE_KEYS.commandVersion, new Error("store down"))

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(true)
      expect(outcome.diagnostics.filter((line) => line.startsWith("command-persist:"))).toHaveLength(1)
      expect(names(fake)).toEqual(["A:deploy"])
      expect(outcome.reloads).toBe(1)
      expect(fake.reloadCalls).toBe(skillReloads + 1)
    } finally {
      await registry.dispose()
    }
  })

  it("R10: a command transform that throws never fails the refresh", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    await ws.command("command", "release.md")
    const { fake, registry } = open(ws.base)

    try {
      fake.failCommandAdd("A:deploy", new Error("nope"))
      const first = await registry.activate()

      expect(first.ok).toBe(true)
      expect(names(fake)).toEqual(["A:release"])

      const second = await registry.refresh()

      expect(second.diagnostics.filter((line) => line.startsWith("command-replay: A:deploy:"))).toHaveLength(1)
    } finally {
      await registry.dispose()
    }
  })

  it("R11: the skill registry and the skill key writes are byte-identical with and without commands", async () => {
    const ws = await publish()

    const without = fakeContext([], { directory: ws.base })
    const withoutWrites = recordStorage(without)
    const first = createRegistry(without.ctx)
    let firstOutcome

    try {
      firstOutcome = await first.activate()
    } finally {
      await first.dispose()
    }

    await ws.command("command", "deploy.md")
    const withCommands = fakeContext([], { directory: ws.base })
    const withWrites = recordStorage(withCommands)
    const second = createRegistry(withCommands.ctx)

    try {
      const secondOutcome = await second.activate()

      expect(skillSignature(withCommands)).toBe(skillSignature(without))
      expect(withWrites.filter(isSkillKey)).toEqual(withoutWrites.filter(isSkillKey))
      expect(secondOutcome.skills).toBe(firstOutcome.skills)
      expect(secondOutcome.subprojects).toBe(firstOutcome.subprojects)
      expect(withWrites.filter(isCommandKey).filter(isSkillKey)).toEqual([])
    } finally {
      await second.dispose()
    }
  })

  it("R12: a location that stops being a directory clears the commands with one reload", async () => {
    const ws = await publish("app")
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      const reloads = fake.commandReloadCalls
      await rm(ws.base, { recursive: true, force: true })

      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(outcome.commands).toBe(0)
      expect(names(fake)).toEqual([])
      expect(fake.commandReloadCalls).toBe(reloads + 1)
    } finally {
      await registry.dispose()
    }
  })

  it("R13: the cache holds no entry for a dropped collision or a suppressed checkout", async () => {
    const collision = await publish("app")
    await collision.command("command", "deploy.md")
    await collision.write(".opencode/command/A:deploy.md", commandDoc("A:deploy"))
    const collided = open(collision.base)

    try {
      await collided.registry.activate()
      expect(JSON.stringify(commandStorage(collided.fake))).not.toContain("A:deploy")
      expect(Object.keys(commandStorage(collided.fake))).toEqual([])
    } finally {
      await collided.registry.dispose()
    }

    const family = await workspace()
    await family.repo("main")
    await family.worktree("wt", "main", "linked")
    for (const checkout of ["main", "wt"]) {
      await checkoutSkill(family, checkout, "checkout")
      await writeCommand(family, checkout, "command", "deploy.md")
    }
    const suppressed = open(family.root)

    try {
      await suppressed.registry.activate()
      const bytes = JSON.stringify(commandStorage(suppressed.fake))

      expect(bytes).toContain("main:deploy")
      expect(bytes).not.toContain("wt:deploy")
      expect(bytes).not.toContain(await realpath(path.join(family.root, "wt")))
    } finally {
      await suppressed.registry.dispose()
    }
  })

  it("R15: a failed native walk keeps the previous commands and still reloads once", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      await ws.command("command", "release.md")
      const reloads = fake.commandReloadCalls

      nativeControl.failure = new Error("walk down")
      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(true)
      expect(outcome.diagnostics.filter((line) => line.startsWith("command-index:"))).toHaveLength(1)
      expect(names(fake)).toEqual(["A:deploy"])
      expect(fake.commandReloadCalls).toBe(reloads + 1)
    } finally {
      await registry.dispose()
    }
  })

  it("R16: a rejected command transform registration never fails the refresh", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      fake.fail("command.transform", new Error("no transform"))
      const first = await registry.activate()

      expect(first.ok).toBe(true)
      expect(first.skills).toBe(1)

      const second = await registry.refresh()

      expect(second.diagnostics).toContain("command-register: no transform")
      expect(fake.commandReloadCalls).toBe(2)
    } finally {
      await registry.dispose()
    }
  })

  it("R14: a skill persistence failure keeps the previous commands", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const { fake, registry } = open(ws.base)

    try {
      await registry.activate()
      await ws.command("command", "release.md")
      const reloads = fake.commandReloadCalls

      manifestControl.failure = new Error("manifest down")
      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(false)
      expect(names(fake)).toEqual(["A:deploy"])
      expect(fake.commandReloadCalls).toBe(reloads)
    } finally {
      await registry.dispose()
    }
  })
})
