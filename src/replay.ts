import type { Skill } from "@opencode/plugin"
import { compareText, type RegistryEntry, type RegistrySnapshot } from "./contracts.ts"
import type { SkillEditor } from "./plugin.ts"

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function toInfo(entry: RegistryEntry): Skill.Info {
  return {
    id: entry.id as Skill.ID,
    name: entry.name as Skill.Name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.autoinvoke === undefined ? {} : { autoinvoke: entry.autoinvoke }),
    path: entry.canonicalPath as Skill.Info["path"],
    content: entry.content,
  }
}

export function applyRegistry(
  editor: SkillEditor,
  snapshot: RegistrySnapshot | undefined,
): readonly string[] {
  if (snapshot === undefined) return []

  const diagnostics: string[] = []
  const entries = snapshot.snapshots
    .flatMap((subproject) => subproject.skills)
    .sort((left, right) => compareText(left.id, right.id))

  for (const entry of entries) {
    try {
      if (editor.get(entry.id) !== undefined) continue
    } catch (error) {
      diagnostics.push(`replay: ${entry.id}: ${reasonOf(error)}`)
      continue
    }

    try {
      editor.add(toInfo(entry))
    } catch (error) {
      diagnostics.push(`replay: ${entry.id}: ${reasonOf(error)}`)
    }
  }

  return diagnostics
}
