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
