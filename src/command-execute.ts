import type { Plugin } from "@opencode/plugin"
import { expandCommand } from "./command-expand.ts"
import { nodeProcessRunner, resolveShell } from "./command-shell.ts"
import type { ProcessRunner } from "./command-shell.ts"
import { modelRefOf } from "./command-model.ts"
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
    // PD5 (native `command.ts:81-92`): the command's agent, then its model, else the agent's.
    const commandAgent =
      target.entry.agent === undefined
        ? undefined
        : (await host.agent.get({ agentID: target.entry.agent })).data
    const model = target.entry.model === undefined ? commandAgent?.model : modelRefOf(target.entry.model)

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

    // PD9 (native `command.ts:124-128`): switch the agent only on a difference, the model
    // whenever one resolved.
    const parent = await host.session.get({ sessionID: invocation.sessionID })
    if (target.entry.agent !== undefined && parent.agent !== target.entry.agent) {
      await host.session.switchAgent({ sessionID: invocation.sessionID, agent: target.entry.agent })
    }
    if (model !== undefined) {
      await host.session.switchModel({ sessionID: invocation.sessionID, model })
    }

    await host.session.prompt({
      ...invocation.prompt,
      sessionID: invocation.sessionID,
      text: expanded.text,
      delivery: invocation.delivery,
    })
  }
}
