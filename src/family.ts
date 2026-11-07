import { resolve } from "node:path"

export interface RepoFamily {
  readonly familyKey: string
  readonly survivor: string
}

export interface FamilyResolution {
  readonly family?: RepoFamily
  readonly diagnostic?: string
}

export interface DeriveFamiliesResult {
  readonly location: string
  readonly families: ReadonlyMap<string, RepoFamily>
  readonly diagnostics: readonly string[]
}

export interface FamilyEntry {
  readonly subprojectRealPath: string
  readonly candidate: { readonly realPath: string }
}

export async function isOwnedCommonDir(_commonDir: string): Promise<boolean> {
  return false
}

export async function resolveRepoFamily(_checkout: string): Promise<FamilyResolution> {
  return {}
}

export async function deriveFamilies(
  checkouts: readonly string[],
  location: string,
): Promise<DeriveFamiliesResult> {
  void checkouts
  return { location: resolve(location), families: new Map(), diagnostics: [] }
}

export function selectSurvivorEntries<T extends FamilyEntry>(
  entries: readonly T[],
  _families: ReadonlyMap<string, RepoFamily>,
  _location: string,
): { readonly kept: readonly T[]; readonly diagnostics: readonly string[] } {
  return { kept: [...entries], diagnostics: [] }
}
