import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandExecutor } from "../src/command-execute.ts"
import { setup } from "../src/plugin.ts"
import { publishWorkspace, type PublishWorkspace } from "./support/command-publish-fixtures.ts"
import { invocation } from "./support/command-route-fixtures.ts"
import { fakeContext } from "./support/fake-context.ts"
import type { FakeContext } from "./support/fake-context.ts"
import type { FamilyWorkspace } from "./support/family-fixtures.ts"

// The production runner is the real `nodeProcessRunner`; its only process seam is mocked so
// the wiring test can observe the argv and the cwd without spawning.
const spawnControl = vi.hoisted(() => ({
  calls: [] as Array<{ readonly file: string; readonly args: readonly string[]; readonly cwd?: string }>,
}))

vi.mock("node:child_process", () => ({
  spawn: (file: string, args: readonly string[], options: { cwd?: string }) => {
    spawnControl.calls.push({ file, args, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
    const stream = { on: () => undefined }
    const child: {
      stdout: typeof stream
      stderr: typeof stream
      on(event: string, callback: (value: unknown) => void): typeof child
    } = {
      stdout: stream,
      stderr: stream,
      on(event, callback) {
        if (event === "close") queueMicrotask(() => callback(0))
        return child
      },
    }
    return child
  },
}))

// No test here waits on a real fs.watch event; the factory is inert.
vi.mock("../src/watch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/watch.ts")>()
  return { ...actual, nodeWatchFactory: () => ({ close: () => undefined }) }
})

const workspaces: FamilyWorkspace[] = []
const homes: string[] = []

const publish = async (): Promise<PublishWorkspace> => {
  const created = await publishWorkspace()
  workspaces.push(created)
  return created
}

beforeEach(async () => {
  spawnControl.calls.length = 0
  const home = await mkdtemp(path.join(tmpdir(), "nested-command-wiring-home-"))
  homes.push(home)
  vi.stubEnv("OPENCODE_TEST_HOME", home)
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(home, ".config", "opencode"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const commandWithShell = `---
description: deploy command
---
Deploy $1
!\`pwd\`
`

const commandNames = (fake: FakeContext): readonly string[] =>
  fake.commandDefinitions.map((entry) => entry.name)

describe("plugin wiring: the execution port", () => {
  it("W1: a published command expands and routes through setup end to end", async () => {
    const ws = await publish()
    await ws.commandDoc("command", "deploy.md", commandWithShell)
    const fake = fakeContext([], { directory: ws.base })
    const cleanup = await setup(fake.ctx)

    try {
      expect(commandNames(fake)).toEqual(["A:deploy"])

      await fake.invokeCommand("A:deploy", invocation({ text: "prod" }))

      expect(fake.prompts).toHaveLength(1)
      expect(fake.prompts[0]?.text).toBe("Deploy prod\n")
      expect(fake.prompts[0]?.sessionID).toBe("parent")
      expect(spawnControl.calls).toHaveLength(1)
      expect(spawnControl.calls[0]?.cwd).toBe(ws.checkout)
      expect(spawnControl.calls[0]?.args).toEqual(["-c", "pwd"])
    } finally {
      await cleanup()
    }
  })

  it("W2: without the option the port stays inert (F5's contract)", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const fake = fakeContext([], { directory: ws.base })
    const { createRegistry } = await import("../src/registry.ts")
    const registry = createRegistry(fake.ctx)

    try {
      const outcome = await registry.activate()

      expect(outcome.commands).toBe(1)
      await fake.invokeCommand("A:deploy", invocation({ text: "prod" }))

      expect(fake.prompts).toEqual([])
      expect(spawnControl.calls).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it("W3: a rejected invocation leaves the registry healthy for the next refresh", async () => {
    const ws = await publish()
    await ws.command("command", "deploy.md")
    const fake = fakeContext([], { directory: ws.base })
    const { createRegistry } = await import("../src/registry.ts")
    const registry = createRegistry(fake.ctx, {
      executeCommand: createCommandExecutor({ session: fake.ctx.session, agent: fake.ctx.agent }),
    })

    try {
      await registry.activate()
      fake.failSession("get", new Error("route down"))

      await expect(fake.invokeCommand("A:deploy", invocation({ text: "prod" }))).rejects.toThrow(
        "route down",
      )

      fake.clearFailures()
      const outcome = await registry.refresh()

      expect(outcome.ok).toBe(true)
      expect(commandNames(fake)).toEqual(["A:deploy"])
      expect(fake.commandTransforms).toHaveLength(1)
    } finally {
      await registry.dispose()
    }
  })
})
