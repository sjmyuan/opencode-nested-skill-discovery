import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { createCommandExecutor } from "../src/command-execute.ts"
import { scriptedRunner } from "./support/command-fixtures.ts"
import { commandEntry, commandTarget, invocation } from "./support/command-route-fixtures.ts"
import { fakeContext } from "./support/fake-context.ts"

// E19 (plan Step 8): the template comes from the snapshot and the process from the injected
// runner, so an invocation must not touch the file system or spawn anything itself.
vi.mock("node:child_process", () => ({
  spawn: (): never => {
    throw new Error("child_process is off limits")
  },
}))

vi.mock("node:fs/promises", () => ({
  readFile: async (): Promise<never> => {
    throw new Error("fs is off limits")
  },
}))

describe("command executor: no direct I/O", () => {
  it("E19: succeeds through the injected runner with fs and child_process forbidden", async () => {
    expect(() => spawn("echo", [])).toThrow("child_process is off limits")
    await expect(readFile("/anything")).rejects.toThrow("fs is off limits")

    const fake = fakeContext()
    const runner = scriptedRunner([{ kind: "ran", exitCode: 0, output: "A" }])
    const executor = createCommandExecutor(
      { session: fake.ctx.session, agent: fake.ctx.agent },
      { shell: { env: {}, platform: "darwin", run: runner.run } },
    )

    await executor(
      commandTarget(commandEntry({ name: "A:deploy", template: "Deploy !`pwd`" })),
      invocation({ text: "prod" }),
    )

    expect(runner.calls).toHaveLength(1)
    expect(fake.prompts.map((prompt) => prompt.text)).toEqual(["Deploy A\n\nprod"])
  })
})
