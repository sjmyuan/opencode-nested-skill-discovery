import type { Plugin } from "@opencode/plugin"
import { expandCommand } from "./command-expand.ts"
import { nodeProcessRunner, resolveShell } from "./command-shell.ts"
import type { ProcessRunner } from "./command-shell.ts"
import { modelRefOf, SUBAGENT_PREFIX } from "./command-model.ts"
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

    // PD10 (native `command.ts:216-240`): a shell failure fails this invocation whole.
    if (expanded.shellFailed) throw new Error(expanded.diagnostics.join("; "))

    // PD4/PD6/PD7 (native `command.ts:98-123`): `??` binds looser than `===`, so an
    // explicit `subagent: false` wins over a subagent-mode agent.
    const session = await host.session.get({ sessionID: invocation.sessionID })
    const subagent = target.entry.subagent ?? commandAgent?.mode === "subagent"

    if (subagent) {
      const selectedID = target.entry.agent ?? session.agent
      const selectedInfo =
        target.entry.agent !== undefined
          ? commandAgent
          : selectedID === undefined
            ? undefined
            : (await host.agent.get({ agentID: selectedID })).data
      const childModel = model ?? selectedInfo?.model ?? session.model
      const child = await host.session.create({
        parentID: session.id,
        title: target.entry.description ?? target.entry.name,
        ...(selectedID === undefined ? {} : { agent: selectedID }),
        ...(childModel === undefined ? {} : { model: childModel }),
      })

      // PD8 (native `command.ts:107-112`): no `delivery` — a brand-new child has nothing
      // to steer yet; `resume: false` asks for a fresh turn.
      await host.session.prompt({
        ...invocation.prompt,
        sessionID: child.id,
        text: [SUBAGENT_PREFIX, expanded.text].join("\n"),
        resume: false,
      })
      return
    }

    // PD9 (native `command.ts:124-128`): switch the agent only on a difference, the model
    // whenever one resolved.
    if (target.entry.agent !== undefined && session.agent !== target.entry.agent) {
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
