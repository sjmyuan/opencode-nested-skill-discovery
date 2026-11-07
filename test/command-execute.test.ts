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
