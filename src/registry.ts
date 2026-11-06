import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  type RegistryEntry,
  type RegistrySnapshot,
  type Snapshot,
} from "./contracts.ts"
import type { IndexedSkill } from "./indexer.ts"
import { scopeTokenFor } from "./indexer.ts"
import { composeName, sanitizeText } from "./names.ts"

const compareId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function canonicalDirectory(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return resolve(target)
  }
}

export interface AssembledEntry extends RegistryEntry {
  readonly subproject: string
}

export function assembleEntries(skills: readonly IndexedSkill[]): readonly AssembledEntry[] {
  return skills
    .map((skill) => {
      const description =
        skill.description === undefined || skill.description.length === 0
          ? undefined
          : sanitizeText(skill.description, MAX_DESCRIPTION_LENGTH)

      return {
        id: skill.id,
        canonicalPath: skill.canonicalPath,
        name: sanitizeText(composeName(skill.subproject, skill.nativeName), MAX_NAME_LENGTH),
        ...(description === undefined ? {} : { description }),
        ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
        content: skill.content,
        subproject: skill.subproject,
      }
    })
    .sort((left, right) => compareId(left.id, right.id))
}

export interface BuildSnapshotInput {
  readonly location: string
  readonly skills: readonly AssembledEntry[]
}

export interface BuildSnapshotResult {
  readonly snapshot: RegistrySnapshot
  readonly diagnostics: readonly string[]
}

export async function buildRegistrySnapshot({
  location,
  skills,
}: BuildSnapshotInput): Promise<BuildSnapshotResult> {
  const canonicalLocation = await canonicalDirectory(location)
  const resolved = new Map<string, string | null>()
  const groups = new Map<string, { readonly directory: string; readonly skills: RegistryEntry[] }>()
  const diagnostics: string[] = []

  for (const skill of skills) {
    let directory = resolved.get(skill.subproject)

    if (directory === undefined) {
      const target = resolve(canonicalLocation, skill.subproject === "" ? "." : skill.subproject)
      try {
        directory = await realpath(target)
      } catch (error) {
        directory = null
        diagnostics.push(`subproject: ${target}: ${reasonOf(error)}`)
      }
      resolved.set(skill.subproject, directory)
    }

    if (directory === null) continue

    const scopeToken = scopeTokenFor(directory)
    const group = groups.get(scopeToken) ?? { directory, skills: [] }
    group.skills.push(skill)
    groups.set(scopeToken, group)
  }

  const snapshots: readonly Snapshot[] = Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => compareId(left, right))
      .map(([scopeToken, group]) =>
        Object.freeze({
          scopeToken,
          directory: group.directory,
          skills: Object.freeze(
            [...group.skills]
              .sort((left, right) => compareId(left.id, right.id))
              .map((entry) => Object.freeze(entry)),
          ),
        }),
      ),
  )

  return {
    snapshot: Object.freeze({ location: canonicalLocation, snapshots }),
    diagnostics,
  }
}
