import type { CommandTarget } from "../../src/command-replay.ts"
import type { CommandEntry } from "../../src/contracts.ts"
import type { CommandInvocation } from "../../src/plugin.ts"

/** A published command entry with only the required fields spelled out. */
export const commandEntry = (overrides: Partial<CommandEntry> & Pick<CommandEntry, "name">): CommandEntry => ({
  canonicalPath: `/repo/A/.opencode/command/${overrides.name}.md`,
  template: "Deploy $1",
  ...overrides,
})

/** The live target the replay resolves: the entry plus its owning subproject. */
export const commandTarget = (entry: CommandEntry, directory = "/repo/A"): CommandTarget => ({
  entry,
  directory,
})

export interface InvocationOverrides {
  readonly sessionID?: CommandInvocation["sessionID"]
  readonly text?: string
  readonly prompt?: CommandInvocation["prompt"]
  readonly delivery?: CommandInvocation["delivery"]
}

/** An invocation whose prompt text is the raw argument text, as the host delivers it. */
export const invocation = (overrides: InvocationOverrides = {}): CommandInvocation => ({
  sessionID: overrides.sessionID ?? ("parent" as CommandInvocation["sessionID"]),
  prompt: overrides.prompt ?? { text: overrides.text ?? "" },
  delivery: overrides.delivery ?? "steer",
})
