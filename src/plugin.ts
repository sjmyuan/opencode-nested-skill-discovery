import type { Plugin } from "@opencode/plugin"
import type { RegistrySnapshot, Snapshot } from "./contracts.ts"
import { createRegistry } from "./registry.ts"
import { applyRegistry } from "./replay.ts"
import { nodeWatchFactory } from "./watch.ts"

export const id = "nested-skill-discovery"

export type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  scopeToken: "",
  directory: "",
  skills: Object.freeze([]),
})

export function applySnapshot(editor: SkillEditor, snapshot: RegistrySnapshot | undefined): void {
  applyRegistry(editor, snapshot)
}

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const registry = createRegistry(ctx, { watchDirectory: nodeWatchFactory })

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
