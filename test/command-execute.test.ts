import { describe, expect, it } from "vitest"
import { createCommandExecutor, type CommandHost } from "../src/command-execute.ts"
import type { CommandInvocation } from "../src/plugin.ts"
import { scriptedRunner } from "./support/command-fixtures.ts"
import { commandEntry, commandTarget, invocation } from "./support/command-route-fixtures.ts"
import { fakeContext, type FakeContext, type FakeContextOptions } from "./support/fake-context.ts"

/** The executor's host is exactly the two domains it is allowed to read (PD2). */
const hostOf = (fake: FakeContext): CommandHost => ({
  session: fake.ctx.session,
  agent: fake.ctx.agent,
})

const shellDefaults = (output = "") => {
  const runner = scriptedRunner([{ kind: "ran", exitCode: 0, output }])
  return {
    runner,
    shell: { env: {}, platform: "darwin", run: runner.run },
  }
}

const executorFor = (fake: FakeContext, shell = shellDefaults().shell) =>
  createCommandExecutor(hostOf(fake), { shell })

const fixture = (options: FakeContextOptions = {}): FakeContext => fakeContext([], options)

describe("command executor: expansion and prompt forwarding", () => {
  it("E1: expands the template and prompts with the delivered delivery", async () => {
    const fake = fixture()
    const entry = commandEntry({ name: "A:deploy", template: "Deploy $1" })
    const executor = executorFor(fake)

    await executor(commandTarget(entry), invocation({ text: "prod --fast", delivery: "queue" }))

    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]?.text).toBe("Deploy prod --fast")
    expect(fake.prompts[0]?.input.delivery).toBe("queue")
  })

  it("E2: files, agents, skills and delivery are forwarded unchanged; only text is replaced", async () => {
    const fake = fixture()
    const entry = commandEntry({ name: "A:deploy", template: "Run $1" })
    const prompt: CommandInvocation["prompt"] = {
      text: "args",
      files: [{ uri: "file:///a.ts" }],
      agents: [{ name: "build" }],
      skills: [{ id: "checkout" }],
    } as unknown as CommandInvocation["prompt"]

    await executorFor(fake)(commandTarget(entry), invocation({ prompt, delivery: "steer" }))

    const sent = fake.prompts[0]?.input
    expect(sent).toMatchObject({
      text: "Run args",
      files: [{ uri: "file:///a.ts" }],
      agents: [{ name: "build" }],
      skills: [{ id: "checkout" }],
      delivery: "steer",
    })
    expect(sent?.sessionID).toBe("parent")
  })

  it("E3: no agent and no model prompts only, with no switch and no child", async () => {
    const fake = fixture()
    const entry = commandEntry({ name: "A:deploy", template: "Deploy" })

    await executorFor(fake)(commandTarget(entry), invocation({ text: "prod" }))

    expect(fake.prompts.map((prompt) => prompt.text)).toEqual(["Deploy\n\nprod"])
    expect(fake.switches).toEqual([])
    expect(fake.childSessions).toEqual([])
  })

  it("E4: two invocations expand independently and never mutate the entry", async () => {
    const fake = fixture()
    const entry = commandEntry({ name: "A:deploy", template: "Deploy $1" })
    const before = structuredClone(entry)
    const executor = executorFor(fake)

    await executor(commandTarget(entry), invocation({ text: "prod" }))
    await executor(commandTarget(entry), invocation({ text: "prod" }))

    expect(fake.prompts.map((prompt) => prompt.text)).toEqual(["Deploy prod", "Deploy prod"])
    expect(entry).toEqual(before)
  })
})

describe("command executor: agent and model routing", () => {
  it("E5: agent X on a session running Y switches the agent once", async () => {
    const fake = fixture({ agents: [{ id: "X" }], sessions: [{ id: "parent", agent: "Y" }] })
    const entry = commandEntry({ name: "A:deploy", agent: "X" })

    await executorFor(fake)(commandTarget(entry), invocation({ text: "prod" }))

    expect(fake.switches).toEqual([{ kind: "agent", sessionID: "parent", value: "X" }])
    expect(fake.prompts).toHaveLength(1)
  })

  it("E6: an already-selected agent is not switched again, but its model is", async () => {
    const fake = fixture({
      agents: [{ id: "X", model: { id: "m", providerID: "p" } }],
      sessions: [{ id: "parent", agent: "X" }],
    })
    const entry = commandEntry({ name: "A:deploy", agent: "X" })

    await executorFor(fake)(commandTarget(entry), invocation({ text: "prod" }))

    expect(fake.switches).toEqual([
      { kind: "model", sessionID: "parent", value: { id: "m", providerID: "p" } },
    ])
  })

  it("E7: an agent-only command switches the model to the agent's model", async () => {
    const fake = fixture({
      agents: [{ id: "X", model: { id: "m", providerID: "p", variant: "v" } }],
      sessions: [{ id: "parent", agent: "X" }],
    })
    const entry = commandEntry({ name: "A:deploy", agent: "X" })

    await executorFor(fake)(commandTarget(entry), invocation({ text: "prod" }))

    expect(fake.switches).toEqual([
      { kind: "model", sessionID: "parent", value: { id: "m", providerID: "p", variant: "v" } },
    ])
  })

  it("E8: a command model wins over the agent's model and carries its variant", async () => {
    const fake = fixture({
      agents: [{ id: "X", model: { id: "agent-model", providerID: "p" } }],
      sessions: [{ id: "parent", agent: "X" }],
    })
    const entry = commandEntry({ name: "A:deploy", agent: "X", model: "anthropic/claude-sonnet#fast" })

    await executorFor(fake)(commandTarget(entry), invocation({ text: "prod" }))

    expect(fake.switches).toEqual([
      {
        kind: "model",
        sessionID: "parent",
        value: { providerID: "anthropic", id: "claude-sonnet", variant: "fast" },
      },
    ])
  })
})

describe("command executor: the subagent child branch", () => {
  it("E9: creates a child with the native fields and prompts it with the prefix", async () => {
    const fake = fixture({
      agents: [{ id: "X", model: { id: "agent-model", providerID: "p" } }],
      sessions: [{ id: "parent", agent: "Y", model: { id: "parent-model", providerID: "pp" } }],
    })
    const entry = commandEntry({
      name: "A:deploy",
      description: "Deploy release",
      agent: "X",
      model: "anthropic/claude#fast",
      subagent: true,
      template: "Deploy $1",
    })

    await executorFor(fake)(commandTarget(entry), invocation({ text: "prod", delivery: "queue" }))

    expect(fake.childSessions).toEqual([
      {
        parentID: "parent",
        title: "Deploy release",
        agent: "X",
        model: { providerID: "anthropic", id: "claude", variant: "fast" },
      },
    ])
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]?.sessionID).toBe("child-1")
    expect(fake.prompts[0]?.text).toBe("You are a subagent spawned by another session.\nDeploy prod")
    expect(fake.prompts[0]?.input.resume).toBe(false)
    expect(fake.prompts[0]?.input).not.toHaveProperty("delivery")
    expect(fake.switches).toEqual([])
  })

  it("E10: child model falls back command model → selected agent model → parent model", async () => {
    const commandModel = fixture({
      agents: [{ id: "X", model: { id: "agent-model", providerID: "p" } }],
      sessions: [{ id: "parent", model: { id: "parent-model", providerID: "pp" } }],
    })
    await executorFor(commandModel)(
      commandTarget(
        commandEntry({ name: "A:deploy", agent: "X", model: "anthropic/claude#fast", subagent: true }),
      ),
      invocation({ text: "prod" }),
    )
    expect(commandModel.childSessions[0]?.model).toEqual({
      providerID: "anthropic",
      id: "claude",
      variant: "fast",
    })

    const agentModel = fixture({
      agents: [{ id: "X", model: { id: "agent-model", providerID: "p" } }],
      sessions: [{ id: "parent", model: { id: "parent-model", providerID: "pp" } }],
    })
    await executorFor(agentModel)(
      commandTarget(commandEntry({ name: "A:deploy", agent: "X", subagent: true })),
      invocation({ text: "prod" }),
    )
    expect(agentModel.childSessions[0]?.model).toEqual({ id: "agent-model", providerID: "p" })

    const parentModel = fixture({
      sessions: [{ id: "parent", model: { id: "parent-model", providerID: "pp" } }],
    })
    await executorFor(parentModel)(
      commandTarget(commandEntry({ name: "A:deploy", subagent: true })),
      invocation({ text: "prod" }),
    )
    expect(parentModel.childSessions[0]?.model).toEqual({ id: "parent-model", providerID: "pp" })
  })

  it("E11: the child agent is the parent's, and is omitted when neither names one", async () => {
    const inherited = fixture({
      agents: [{ id: "P" }],
      sessions: [{ id: "parent", agent: "P" }],
    })
    await executorFor(inherited)(
      commandTarget(commandEntry({ name: "A:deploy", subagent: true })),
      invocation({ text: "prod" }),
    )
    expect(inherited.childSessions[0]?.agent).toBe("P")

    const omitted = fixture({ sessions: [{ id: "parent" }] })
    await executorFor(omitted)(
      commandTarget(commandEntry({ name: "A:deploy", subagent: true })),
      invocation({ text: "prod" }),
    )
    expect(omitted.childSessions[0]).not.toHaveProperty("agent")
  })

  it("E12: a resolved agent in subagent mode takes the child path", async () => {
    const fake = fixture({
      agents: [{ id: "X", mode: "subagent" }],
      sessions: [{ id: "parent", agent: "P" }],
    })

    await executorFor(fake)(
      commandTarget(commandEntry({ name: "A:deploy", agent: "X" })),
      invocation({ text: "prod" }),
    )

    expect(fake.childSessions).toHaveLength(1)
    expect(fake.prompts[0]?.sessionID).toBe("child-1")
    expect(fake.switches).toEqual([])
  })

  it("E13: an explicit subagent: false beats the agent mode and stays on the parent", async () => {
    const fake = fixture({
      agents: [{ id: "X", mode: "subagent", model: { id: "m", providerID: "p" } }],
      sessions: [{ id: "parent", agent: "Y" }],
    })
    const entry = commandEntry({ name: "A:deploy", agent: "X", subagent: false })

    await executorFor(fake)(commandTarget(entry), invocation({ text: "prod" }))

    expect(fake.childSessions).toEqual([])
    expect(fake.switches).toEqual([
      { kind: "agent", sessionID: "parent", value: "X" },
      { kind: "model", sessionID: "parent", value: { id: "m", providerID: "p" } },
    ])
    expect(fake.prompts[0]?.sessionID).toBe("parent")
  })
})

describe("command executor: shell and failure isolation", () => {
  it("E14: the shell runs in the owning subproject with the resolved argv shape", async () => {
    const fake = fixture()
    const runner = scriptedRunner([{ kind: "ran", exitCode: 0, output: "A" }])
    const executor = createCommandExecutor(hostOf(fake), {
      shell: { env: {}, platform: "darwin", run: runner.run },
    })

    await executor(
      commandTarget(commandEntry({ name: "A:deploy", template: "Deploy !`pwd`" }), "/repo/A"),
      invocation({ text: "" }),
    )

    expect(runner.calls).toEqual([{ file: "/bin/zsh", args: ["-c", "pwd"], cwd: "/repo/A" }])
    expect(fake.prompts[0]?.text).toBe("Deploy A")
  })

  it("E15: a shell failure rejects before any switch, create or prompt", async () => {
    const fake = fixture()
    const runner = scriptedRunner([{ kind: "failed", message: "boom" }])
    const executor = createCommandExecutor(hostOf(fake), {
      shell: { env: {}, platform: "darwin", run: runner.run },
    })

    await expect(
      executor(commandTarget(commandEntry({ name: "A:deploy", template: "Run !`echo hi`" })), invocation()),
    ).rejects.toThrow('Shell interpolation failed for "echo hi": boom')

    expect(fake.sessionCalls).toEqual([])
    expect(fake.switches).toEqual([])
    expect(fake.childSessions).toEqual([])
    expect(fake.prompts).toEqual([])
  })

  it("E16: a rejected session read surfaces and sends no prompt", async () => {
    const fake = fixture()
    fake.failSession("get", new Error("session down"))

    await expect(
      executorFor(fake)(commandTarget(commandEntry({ name: "A:deploy" })), invocation()),
    ).rejects.toThrow("session down")

    expect(fake.prompts).toEqual([])
    expect(fake.switches).toEqual([])
  })
})

describe("command executor: no permission gate", () => {
  it("E17: only the session and agent domains are read (R18)", async () => {
    const fake = fixture({
      agents: [{ id: "X", mode: "subagent", model: { id: "m", providerID: "p" } }],
      sessions: [{ id: "parent", model: { id: "parent-model", providerID: "pp" } }],
    })
    const reads: string[] = []
    const base = { session: fake.ctx.session, agent: fake.ctx.agent }
    const host = new Proxy(base, {
      get(target, property, receiver) {
        if (typeof property === "string") reads.push(property)
        if (property === "session" || property === "agent") {
          return Reflect.get(target, property, receiver)
        }
        throw new Error(`forbidden host read: ${String(property)}`)
      },
    }) as CommandHost
    const executor = createCommandExecutor(host, { shell: shellDefaults().shell })

    await executor(commandTarget(commandEntry({ name: "A:deploy" })), invocation({ text: "prod" }))
    await executor(
      commandTarget(commandEntry({ name: "A:spawn", agent: "X", subagent: true })),
      invocation({ text: "prod" }),
    )

    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((read) => read === "session" || read === "agent")).toBe(true)
    expect(fake.prompts).toHaveLength(2)
  })
})
