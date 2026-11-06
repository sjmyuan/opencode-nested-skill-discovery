import type { Plugin } from "@opencode/plugin"
import type { Snapshot } from "./contracts.ts"

export const id = "nested-skill-discovery"

export type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  scopeToken: "",
  directory: "",
  skills: Object.freeze([]),
})

export function applySnapshot(_editor: SkillEditor, snapshot: Snapshot | undefined): void {
  if (snapshot === undefined || snapshot.skills.length === 0) return
  // F5 replays a populated snapshot here; F1 must not touch the registry.
}

interface SnapshotHolder {
  snapshot: Snapshot | undefined
}

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const state: SnapshotHolder = { snapshot: EMPTY_SNAPSHOT }
  const registration = await ctx.skill.transform((editor) => applySnapshot(editor, state.snapshot))

  return async () => {
    await registration.dispose()
  }
}

export const definition: Plugin.Plugin = { id, setup }
