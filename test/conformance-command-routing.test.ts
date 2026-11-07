import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandExecutor, type CommandHost } from "../src/command-execute.ts"
import { SUBAGENT_PREFIX } from "../src/command-model.ts"
import { STORAGE_KEYS } from "../src/contracts.ts"
import { scopeTokenFor } from "../src/indexer.ts"
import type { CommandInvocation } from "../src/plugin.ts"
import { createRegistry, type Registry } from "../src/registry.ts"
import { ran, scriptedRunner, type FakeRunner } from "./support/command-fixtures.ts"
import { writeCommandDoc } from "./support/command-family-fixtures.ts"
import { fakeContext, type FakeContext, type FakeContextOptions } from "./support/fake-context.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

const workspaces: FamilyWorkspace[] = []
const homes: string[] = []

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nested-command-routing-home-"))
  homes.push(home)
  vi.stubEnv("OPENCODE_TEST_HOME", home)
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(home, ".config", "opencode"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

afterAll(async () => {
  await Promise.all(workspaces.map((workspace) => workspace.cleanup()))
})

const workspace = async (): Promise<FamilyWorkspace> => {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

const hostOf = (fake: FakeContext): CommandHost => ({ session: fake.ctx.session, agent: fake.ctx.agent })

const shellOf = (runner: FakeRunner) => ({ env: {}, platform: "darwin", run: runner.run })

/** The PD3 seam: the registry hands the executor a live target; the shell is scripted. */
const open = (
  ws: FamilyWorkspace,
  options: FakeContextOptions = {},
  runner: FakeRunner = scriptedRunner([]),
): { readonly fake: FakeContext; readonly registry: Registry; readonly runner: FakeRunner } => {
  const fake = fakeContext([], { directory: ws.root, ...options })
  const registry = createRegistry(fake.ctx, {
    executeCommand: createCommandExecutor(hostOf(fake), { shell: shellOf(runner) }),
  })
  return { fake, registry, runner }
}

const invocation = (
  text: string,
  overrides: Partial<CommandInvocation> = {},
): CommandInvocation => ({
  sessionID: "parent" as CommandInvocation["sessionID"],
  prompt: { text },
  delivery: "steer",
  ...overrides,
})

describe("conformance: invocation parity through the registry", () => {
  it("CC5: a published nested command expands, forwards and runs the shell in its subproject", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await writeCommandDoc(
      ws,
      "main/packages/app",
      "command",
      "tidy.md",
      "---\ndescription: Tidy the app\n---\nTidy $1 then $2\n\n!`pwd`\n",
    )
    const runner = scriptedRunner([ran("/repo/app\n")])
    const { fake, registry } = open(ws, {}, runner)
    const nested = await realpath(path.join(ws.root, "main/packages/app"))
    const prompt = {
      text: "app --fast extra",
      files: [{ uri: "file:///a.ts" }],
      agents: [{ name: "build" }],
      skills: [{ id: "checkout" }],
    } as unknown as CommandInvocation["prompt"]

    try {
      await registry.activate()
      await fake.invokeCommand("main:packages:app:tidy", invocation("app --fast extra", { prompt, delivery: "queue" }))

      expect(fake.prompts).toHaveLength(1)
      expect(fake.prompts[0]?.text).toBe("Tidy app then --fast extra\n\n/repo/app\n")
      expect(fake.prompts[0]?.input).toMatchObject({
        delivery: "queue",
        files: [{ uri: "file:///a.ts" }],
        agents: [{ name: "build" }],
        skills: [{ id: "checkout" }],
      })
      expect(fake.sessionCalls).toEqual(["get", "prompt"])
      expect(runner.calls[0]).toEqual({ file: "/bin/zsh", args: ["-c", "pwd"], cwd: nested })
    } finally {
      await registry.dispose()
    }
  })
})

const buildAgentLocation = async (): Promise<FamilyWorkspace> => {
  const ws = await workspace()
  await ws.repo("main")
  const commands: ReadonlyArray<readonly [string, string]> = [
    ["switch", "---\ndescription: Switch everything\nagent: build\nmodel: anthropic/claude-sonnet\n---\nSwitch\n"],
    ["same", "---\ndescription: Same agent\nagent: build\n---\nSame\n"],
    ["spawn-command", "---\ndescription: Spawn by command\nsubagent: true\nmodel: deepseek/deepseek-flash\n---\nSpawn command\n"],
    ["spawn-agent", "---\ndescription: Spawn by agent\nsubagent: true\nagent: build\n---\nSpawn agent\n"],
    ["spawn-session", "---\ndescription: Spawn by session\nsubagent: true\n---\nSpawn session\n"],
  ]
  for (const [name, content] of commands) await writeCommandDoc(ws, "main", "command", `${name}.md`, content)
  return ws
}

const agentContext: FakeContextOptions = {
  agents: [{ id: "build", model: { providerID: "agent", id: "agent-model" } }, { id: "plan" }],
  sessions: [
    { id: "parent", agent: "plan", model: { providerID: "session", id: "session-model" } },
    { id: "already", agent: "build", model: { providerID: "session", id: "session-model" } },
    { id: "fresh", agent: "plan", model: { providerID: "session", id: "session-model" } },
  ],
}

describe("conformance: agent, model and child routing", () => {
  it("CC6: an agent switches only on a difference and a subagent resolves command → agent → session", async () => {
    const ws = await buildAgentLocation()
    const { fake, registry } = open(ws, agentContext)

    try {
      await registry.activate()

      await fake.invokeCommand("main:switch", invocation("now"))
      expect(fake.switches).toEqual([
        { kind: "agent", sessionID: "parent", value: "build" },
        { kind: "model", sessionID: "parent", value: { providerID: "anthropic", id: "claude-sonnet" } },
      ])
      const switchText = fake.prompts.at(-1)?.text ?? ""
      expect(switchText.startsWith("Switch")).toBe(true)
      expect(switchText.endsWith("now")).toBe(true)

      const afterSwitch = fake.switches.length
      await fake.invokeCommand("main:same", invocation("now", { sessionID: "already" as CommandInvocation["sessionID"] }))
      expect(fake.switches.slice(afterSwitch)).toEqual([
        { kind: "model", sessionID: "already", value: { providerID: "agent", id: "agent-model" } },
      ])

      const afterSame = fake.switches.length
      for (const name of ["main:spawn-command", "main:spawn-agent", "main:spawn-session"]) {
        await fake.invokeCommand(name, invocation("now", { sessionID: "fresh" as CommandInvocation["sessionID"] }))
      }

      expect(fake.childSessions).toEqual([
        {
          parentID: "fresh",
          title: "Spawn by command",
          agent: "plan",
          model: { providerID: "deepseek", id: "deepseek-flash" },
        },
        {
          parentID: "fresh",
          title: "Spawn by agent",
          agent: "build",
          model: { providerID: "agent", id: "agent-model" },
        },
        {
          parentID: "fresh",
          title: "Spawn by session",
          agent: "plan",
          model: { providerID: "session", id: "session-model" },
        },
      ])
      const childPrompts = fake.prompts.filter((prompt) => prompt.sessionID.startsWith("child-"))
      expect(childPrompts.map((prompt) => prompt.text.startsWith(`${SUBAGENT_PREFIX}\n`))).toEqual([true, true, true])
      expect(childPrompts.map((prompt) => prompt.text.endsWith("now"))).toEqual([true, true, true])
      expect(childPrompts.map((prompt) => prompt.input.resume)).toEqual([false, false, false])
      expect(fake.prompts.some((prompt) => prompt.sessionID === "fresh")).toBe(false)
      expect(fake.switches.slice(afterSame)).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it("CC7: a model mapping is stored as one canonical string and routed back to the switch ref", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await writeCommandDoc(
      ws,
      "main",
      "command",
      "flow.md",
      "---\ndescription: Flow model\nmodel: {providerID: deepseek, model: deepseek-flash}\n---\nFlow\n",
    )
    await writeCommandDoc(
      ws,
      "main",
      "command",
      "block.md",
      "---\ndescription: Block model\nmodel:\n  providerID: anthropic\n  model: claude-sonnet\n  variant: fast\n---\nBlock\n",
    )
    const { fake, registry } = open(ws, agentContext)
    const token = scopeTokenFor(await realpath(path.join(ws.root, "main")))

    try {
      await registry.activate()
      const stored = fake.storage.get(STORAGE_KEYS.commandSnapshot(token)) as
        | { readonly commands?: ReadonlyArray<{ readonly name?: string; readonly model?: string }> }
        | undefined
      const models = Object.fromEntries(
        (stored?.commands ?? []).map((entry) => [String(entry.name), entry.model]),
      )

      expect(models).toEqual({
        "main:block": "anthropic/claude-sonnet#fast",
        "main:flow": "deepseek/deepseek-flash",
      })
      expect((await fake.ctx.command.list()).data.map((entry) => entry.name).sort()).toEqual([
        "main:block",
        "main:flow",
      ])

      await fake.invokeCommand("main:block", invocation("go"))

      expect(fake.switches).toEqual([
        {
          kind: "model",
          sessionID: "parent",
          value: { providerID: "anthropic", id: "claude-sonnet", variant: "fast" },
        },
      ])
    } finally {
      await registry.dispose()
    }
  })
})
