import { describe, expect, it, vi } from "vitest"
import { createCommandExecutor, type CommandHost } from "../src/command-execute.ts"
import { scriptedRunner } from "./support/command-fixtures.ts"
import { commandEntry, commandTarget, invocation } from "./support/command-route-fixtures.ts"
import { fakeContext } from "./support/fake-context.ts"

// E18 (plan PD3): the executor consumes F6's expander, it never re-implements it.
const expandControl = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock("../src/command-expand.ts", () => ({
  expandCommand: async (input: unknown) => {
    expandControl.calls.push(input)
    return { text: "expanded text", diagnostics: [], shellFailed: false }
  },
}))

describe("command executor: the expander seam", () => {
  it("E18: calls expandCommand once per invocation with the frozen shape", async () => {
    expandControl.calls.length = 0
    const fake = fakeContext()
    const host: CommandHost = { session: fake.ctx.session, agent: fake.ctx.agent }
    const runner = scriptedRunner([])
    const executor = createCommandExecutor(host, {
      shell: { env: {}, platform: "darwin", run: runner.run },
    })
    const entry = commandEntry({ name: "A:deploy", template: "Deploy $1" })

    await executor(commandTarget(entry, "/repo/A"), invocation({ text: "prod" }))

    expect(expandControl.calls).toHaveLength(1)
    expect(expandControl.calls[0]).toEqual({
      template: "Deploy $1",
      args: "prod",
      shell: {
        target: { file: "/bin/zsh", family: "posix" },
        cwd: "/repo/A",
        run: runner.run,
      },
    })
    expect(fake.prompts.map((prompt) => prompt.text)).toEqual(["expanded text"])
  })
})
