import { isAbsolute, relative, sep } from "node:path"
import type { Schema } from "effect"
import {
  STORAGE_KEYS,
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
}

export interface PersistResult {
  readonly version: number
  readonly pruned: number
  readonly diagnostics: readonly string[]
}

const PRUNE_PAGE_SIZE = 100

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

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
  { location, snapshots, now }: PersistInput,
): Promise<PersistResult> {
  const current = toCounter(await storage.get(STORAGE_KEYS.version))
  const version = Math.max(current + 1, now ?? Date.now())

  await storage.set(STORAGE_KEYS.version, version)

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

    await storage.set(STORAGE_KEYS.manifest(snapshot.scopeToken), asJson(manifest))
    await storage.set(STORAGE_KEYS.subproject(snapshot.scopeToken), asJson(cached))
    active.add(snapshot.scopeToken)
  }

  const diagnostics: string[] = []
  let pruned = 0

  try {
    pruned += await prunePrefix(storage, STORAGE_KEYS.manifest(""), active, location)
    pruned += await prunePrefix(storage, STORAGE_KEYS.subproject(""), active, location)
  } catch (error) {
    diagnostics.push(`prune: ${reasonOf(error)}`)
    return { version, pruned: 0, diagnostics }
  }

  return { version, pruned, diagnostics }
}
