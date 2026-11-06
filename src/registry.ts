import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  type RegistryEntry,
} from "./contracts.ts"
import type { IndexedSkill } from "./indexer.ts"
import { composeName, sanitizeText } from "./names.ts"

const compareId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export function assembleEntries(skills: readonly IndexedSkill[]): readonly RegistryEntry[] {
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
      }
    })
    .sort((left, right) => compareId(left.id, right.id))
}
