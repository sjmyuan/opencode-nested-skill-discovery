import type { Plugin } from "@opencode/plugin"
import { createCommandExecutor } from "./command-execute.ts"
import type { RegistrySnapshot, Snapshot } from "./contracts.ts"
import { createRegistry } from "./registry.ts"
import { applyRegistry } from "./replay.ts"
import { nodeWatchFactory } from "./watch.ts"

export const id = "nested-skill-discovery"

export type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]
export type CommandEditor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]
export type CommandInvocation = Parameters<Parameters<CommandEditor["add"]>[0]["execute"]>[0]

export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  scopeToken: "",
  directory: "",
  skills: Object.freeze([]),
})

export function applySnapshot(editor: SkillEditor, snapshot: RegistrySnapshot | undefined): void {
  applyRegistry(editor, snapshot)
}

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  // Invocation routing lives in `src/command-execute.ts`; the registry only hands it the
  // live target (ADR command R12–R14), so a published command is no longer inert.
  const registry = createRegistry(ctx, {
    watchDirectory: nodeWatchFactory,
    executeCommand: createCommandExecutor(ctx),
  })

  try {
    await registry.activate()
  } catch {
    // Activation is total by contract; a throw here must not reject setup.
  }

  return async () => {
    await registry.dispose()
  }
}

export const definition: Plugin.Plugin = { id, setup }
