import type { ScanCandidate } from "./contracts.ts"

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

export function slug(_input: string, _cap: number): string {
  return ""
}

export function nativeIdFor(_filePath: string): string {
  return ""
}

export function scopeTokenFor(_subprojectRealPath: string): string {
  return ""
}

export function skillTokenFor(_nativeId: string, _skillRealPath: string): string {
  return ""
}

export async function indexCandidates(
  _candidates: readonly ScanCandidate[],
  _options: IndexOptions,
): Promise<{ skills: readonly IndexedSkill[]; diagnostics: readonly string[] }> {
  return { skills: [], diagnostics: [] }
}
