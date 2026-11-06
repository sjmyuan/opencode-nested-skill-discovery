import { isAbsolute, relative, sep } from "node:path"
import type { Schema } from "effect"
import {
  STORAGE_KEYS,
  compareText,
  type ManifestRecord,
  type RegistryEntry,
  type SkillEntry,
  type Snapshot,
} from "./contracts.ts"

export interface StorageScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

export interface StoragePort {
  get(key: string): Promise<Schema.Json | undefined>
  set(key: string, value: Schema.Json): Promise<void>
  remove(key: string): Promise<void>
  scan(options: StorageScanOptions): Promise<{
    readonly entries: readonly { readonly key: string; readonly value: Schema.Json }[]
    readonly next?: string
  }>
}

export interface PersistInput {
  readonly location: string
  readonly snapshots: readonly Snapshot[]
  readonly now?: number
  readonly version?: number
}

export interface PersistResult {
  readonly ok: boolean
  readonly version: number
  readonly pruned: number
  readonly diagnostics: readonly string[]
}

const PRUNE_PAGE_SIZE = 100

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const asJson = (value: unknown): Schema.Json => value as Schema.Json

const toCounter = (value: Schema.Json | undefined): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0

const toManifestEntry = (entry: RegistryEntry): SkillEntry => ({
  id: entry.id,
  canonicalPath: entry.canonicalPath,
  name: entry.name,
  ...(entry.description === undefined ? {} : { description: entry.description }),
  ...(entry.autoinvoke === undefined ? {} : { autoinvoke: entry.autoinvoke }),
})

const toCachedEntry = (entry: RegistryEntry): RegistryEntry => ({
  id: entry.id,
  canonicalPath: entry.canonicalPath,
  name: entry.name,
  ...(entry.description === undefined ? {} : { description: entry.description }),
  ...(entry.autoinvoke === undefined ? {} : { autoinvoke: entry.autoinvoke }),
  content: entry.content,
})

const isInside = (target: string, root: string): boolean => {
  const relativePath = relative(root, target)
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

const directoryOf = (value: Schema.Json): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const directory = (value as { directory?: unknown }).directory
  return typeof directory === "string" ? directory : undefined
}

async function prunePrefix(
  storage: StoragePort,
  prefix: string,
  active: ReadonlySet<string>,
  location: string,
): Promise<number> {
  let removed = 0
  let after: string | undefined

  for (;;) {
    const page = await storage.scan({
      prefix,
      limit: PRUNE_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    })

    for (const entry of page.entries) {
      if (entry.key === STORAGE_KEYS.version) continue
      const token = entry.key.slice(prefix.length)
      if (token.length === 0 || active.has(token)) continue
      const directory = directoryOf(entry.value)
      if (directory === undefined || !isInside(directory, location)) continue
      await storage.remove(entry.key)
      removed += 1
    }

    if (page.next === undefined || page.next === after) return removed
    after = page.next
  }
}

export async function persistRegistry(
  storage: StoragePort,
  { location, snapshots, now, version: reuse }: PersistInput,
): Promise<PersistResult> {
  let version = reuse

  if (version === undefined) {
    let current: Schema.Json | undefined

    try {
      current = await storage.get(STORAGE_KEYS.version)
    } catch (error) {
      return { ok: false, version: 0, pruned: 0, diagnostics: [`version: ${reasonOf(error)}`] }
    }

    version = Math.max(toCounter(current) + 1, now ?? Date.now())
  }

  try {
    await storage.set(STORAGE_KEYS.version, version)
  } catch (error) {
    return { ok: false, version, pruned: 0, diagnostics: [`version: ${reasonOf(error)}`] }
  }

  const ordered = [...snapshots].sort((left, right) => compareText(left.scopeToken, right.scopeToken))
  const active = new Set<string>()

  for (const snapshot of ordered) {
    const manifest: ManifestRecord = {
      manifestVersion: version,
      scopeToken: snapshot.scopeToken,
      directory: snapshot.directory,
      entries: snapshot.skills.map(toManifestEntry),
    }
    const cached: Snapshot = {
      scopeToken: snapshot.scopeToken,
      directory: snapshot.directory,
      skills: snapshot.skills.map(toCachedEntry),
    }

    try {
      await storage.set(STORAGE_KEYS.manifest(snapshot.scopeToken), asJson(manifest))
    } catch (error) {
      return {
        ok: false,
        version,
        pruned: 0,
        diagnostics: [`manifest: ${snapshot.scopeToken}: ${reasonOf(error)}`],
      }
    }

    try {
      await storage.set(STORAGE_KEYS.subproject(snapshot.scopeToken), asJson(cached))
    } catch (error) {
      return {
        ok: false,
        version,
        pruned: 0,
        diagnostics: [`snapshot: ${snapshot.scopeToken}: ${reasonOf(error)}`],
      }
    }

    active.add(snapshot.scopeToken)
  }

  const diagnostics: string[] = []
  let pruned = 0

  try {
    pruned += await prunePrefix(storage, STORAGE_KEYS.manifest(""), active, location)
    pruned += await prunePrefix(storage, STORAGE_KEYS.subproject(""), active, location)
  } catch (error) {
    diagnostics.push(`prune: ${reasonOf(error)}`)
    return { ok: true, version, pruned: 0, diagnostics }
  }

  return { ok: true, version, pruned, diagnostics }
}
