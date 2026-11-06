import { createHash } from "node:crypto"
import path from "node:path"
import {
  type ScanCandidate,
  MAX_SCOPE_SLUG_LENGTH,
  MAX_SKILL_SLUG_LENGTH,
} from "./contracts.ts"

export interface IndexedSkill {
  readonly id: string
  readonly canonicalPath: string
  readonly subproject: string
  readonly nativeName: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly content: string
}

export interface IndexOptions {
  readonly location: string
  readonly nativeRoots?: readonly string[]
}

const hash8 = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8)

export function slug(input: string, cap: number): string {
  const collapsed = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (collapsed.length === 0) return "x"
  return collapsed.slice(0, cap).replace(/-+$/g, "") || "x"
}

export function nativeIdFor(filePath: string): string {
  const base = path.basename(filePath)
  if (base === "SKILL.md") return path.basename(path.dirname(filePath))
  return base.endsWith(".md") ? base.slice(0, -".md".length) : base
}

export function scopeTokenFor(subprojectRealPath: string): string {
  return `${slug(path.basename(subprojectRealPath), MAX_SCOPE_SLUG_LENGTH)}-${hash8(subprojectRealPath)}`
}

export function skillTokenFor(nativeId: string, skillRealPath: string): string {
  return `${slug(nativeId, MAX_SKILL_SLUG_LENGTH)}-${hash8(skillRealPath)}`
}

export async function indexCandidates(
  _candidates: readonly ScanCandidate[],
  _options: IndexOptions,
): Promise<{ skills: readonly IndexedSkill[]; diagnostics: readonly string[] }> {
  return { skills: [], diagnostics: [] }
}
