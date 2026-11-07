import type { Plugin } from "@opencode/plugin"
import { expandCommand } from "./command-expand.ts"
import { nodeProcessRunner, resolveShell } from "./command-shell.ts"
import type { ProcessRunner } from "./command-shell.ts"
import type { CommandExecutor } from "./command-replay.ts"

/**
 * Invocation-time routing for a published command (plan PD1–PD11; ADR command R9–R13).
 *
 * The registry hands this executor the live target; nothing here reads storage, the
 * permission domain or the command registry. The host is deliberately narrow: two
 * domains, so no gate can be added without changing the type (`CommandHost`).
 */
export interface CommandHost {
  readonly session: Pick<Plugin.Context["session"], "get" | "create" | "switchAgent" | "switchModel" | "prompt">
  readonly agent: Pick<Plugin.Context["agent"], "get">
}

export interface ExecuteShellDefaults {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: string
  readonly run: ProcessRunner
}

export interface CommandExecuteOptions {
  readonly shell?: ExecuteShellDefaults
}

export function createCommandExecutor(host: CommandHost, options: CommandExecuteOptions = {}): CommandExecutor {
  // PD15: the defaults are captured once, by reference, at construction.
  const env = options.shell?.env ?? process.env
  const platform = options.shell?.platform ?? process.platform
  const run = options.shell?.run ?? nodeProcessRunner

  return async (target, invocation) => {
    const expanded = await expandCommand({
      template: target.entry.template,
      args: invocation.prompt.text,
      shell: {
        target: resolveShell({ env, platform }),
        // Q9: the owning subproject's realpath, already carried by the target.
        cwd: target.directory,
        run,
      },
    })

    await host.session.prompt({
      ...invocation.prompt,
      sessionID: invocation.sessionID,
      text: expanded.text,
      delivery: invocation.delivery,
    })
  }
}
