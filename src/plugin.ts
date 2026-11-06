import type { Plugin } from "@opencode/plugin"
import type { RegistrySnapshot, Snapshot } from "./contracts.ts"
import { applyRegistry } from "./replay.ts"

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

interface SnapshotHolder {
  snapshot: RegistrySnapshot | undefined
}

function createSnapshotHolder(initial: RegistrySnapshot | undefined): SnapshotHolder {
  return { snapshot: initial }
}

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const state = createSnapshotHolder(undefined)
  const registration = await ctx.skill.transform((editor) => applySnapshot(editor, state.snapshot))

  return async () => {
    await registration.dispose()
  }
}

export const definition: Plugin.Plugin = { id, setup }
