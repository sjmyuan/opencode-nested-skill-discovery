import { isAbsolute, relative, sep } from "node:path"
import type { Schema } from "effect"
import {
  LEGACY_STORAGE_PREFIXES,
  STORAGE_FORMAT,
  STORAGE_FORMAT_KEY,
  STORAGE_KEYS,
  compareText,
  type CommandEntry,
  type CommandManifestEntry,
  type CommandSnapshot,
  type ManifestRecord,
  type RegistryEntry,
  type SkillEntry,
  type Snapshot,
} from "./contracts.ts"
import { locationTokenFor } from "./indexer.ts"

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

/** Every page under `prefix`, one bounded scan at a time (host paging: `after` is exclusive). */
async function* pages(storage: StoragePort, prefix: string): AsyncGenerator<readonly StoredEntry[]> {
  let after: string | undefined

  for (;;) {
    const page = await storage.scan({
      prefix,
      limit: PRUNE_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    })
    yield page.entries
    if (page.next === undefined || page.next === after) return
    after = page.next
  }
}

async function prunePrefix(
  storage: StoragePort,
  prefix: string,
  active: ReadonlySet<string>,
  location: string,
  skipKey: (key: string) => boolean = () => false,
): Promise<number> {
  let removed = 0

  for await (const entries of pages(storage, prefix)) {
    for (const entry of entries) {
      if (skipKey(entry.key)) continue
      const token = entry.key.slice(prefix.length)
      if (token.length === 0 || active.has(token)) continue
      const directory = directoryOf(entry.value)
      if (directory === undefined || !isInside(directory, location)) continue
      await storage.remove(entry.key)
      removed += 1
    }
  }

  return removed
}

/**
 * Writes this location's manifest and cache, then prunes its own stale tokens.
 *
 * `location` must already be canonical: the key segment is derived from it verbatim,
 * so one directory reached through two paths would own two key sets.
 */
export async function persistRegistry(
  storage: StoragePort,
  { location, snapshots, now, version: reuse }: PersistInput,
): Promise<PersistResult> {
  const locationToken = locationTokenFor(location)
  let version = reuse

  if (version === undefined) {
    let current: Schema.Json | undefined

    try {
      current = await storage.get(STORAGE_KEYS.version(locationToken))
    } catch (error) {
      return { ok: false, version: 0, pruned: 0, diagnostics: [`version: ${reasonOf(error)}`] }
    }

    version = Math.max(toCounter(current) + 1, now ?? Date.now())
  }

  try {
    await storage.set(STORAGE_KEYS.version(locationToken), version)
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
      await storage.set(STORAGE_KEYS.manifest(locationToken, snapshot.scopeToken), asJson(manifest))
    } catch (error) {
      return {
        ok: false,
        version,
        pruned: 0,
        diagnostics: [`manifest: ${snapshot.scopeToken}: ${reasonOf(error)}`],
      }
    }

    try {
      await storage.set(STORAGE_KEYS.subproject(locationToken, snapshot.scopeToken), asJson(cached))
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
    const skipVersion = (key: string): boolean => key === STORAGE_KEYS.version(locationToken)
    pruned += await prunePrefix(storage, STORAGE_KEYS.manifest(locationToken, ""), active, location, skipVersion)
    pruned += await prunePrefix(storage, STORAGE_KEYS.subproject(locationToken, ""), active, location)
  } catch (error) {
    diagnostics.push(`prune: ${reasonOf(error)}`)
    return { ok: true, version, pruned: 0, diagnostics }
  }

  diagnostics.push(...(await migrateLegacy(storage)))

  return { ok: true, version, pruned, diagnostics }
}

export interface PersistCommandsInput {
  readonly location: string
  readonly snapshots: readonly CommandSnapshot[]
  readonly now?: number
}

export interface PersistCommandsResult {
  readonly ok: boolean
  readonly version: number
  readonly written: boolean
  readonly pruned: number
  readonly diagnostics: readonly string[]
}

interface CommandManifestRecord {
  readonly manifestVersion: number
  readonly scopeToken: string
  readonly directory: string
  readonly entries: readonly CommandManifestEntry[]
}

interface CommandCacheRecord {
  readonly manifestVersion: number
  readonly scopeToken: string
  readonly directory: string
  readonly commands: readonly CommandEntry[]
}

const toCommandManifestEntry = (entry: CommandEntry): CommandManifestEntry => ({
  name: entry.name,
  canonicalPath: entry.canonicalPath,
  ...(entry.description === undefined ? {} : { description: entry.description }),
  ...(entry.agent === undefined ? {} : { agent: entry.agent }),
  ...(entry.model === undefined ? {} : { model: entry.model }),
  ...(entry.subagent === undefined ? {} : { subagent: entry.subagent }),
})

const toCachedCommand = (entry: CommandEntry): CommandEntry => ({
  ...toCommandManifestEntry(entry),
  template: entry.template,
})

const commandSignature = (directory: string, commands: readonly CommandEntry[]): string =>
  JSON.stringify({
    directory,
    entries: [...commands]
      .sort((left, right) => compareText(left.name, right.name))
      .map((entry) => [
        entry.name,
        entry.canonicalPath,
        entry.description ?? null,
        entry.agent ?? null,
        entry.model ?? null,
        entry.subagent ?? null,
        entry.template,
      ]),
  })

const storedSignature = (value: Schema.Json | undefined): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const directory = (value as { directory?: unknown }).directory
  const commands = (value as { commands?: unknown }).commands
  if (typeof directory !== "string" || !Array.isArray(commands)) return undefined

  const entries: unknown[][] = []
  for (const item of commands) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined
    const entry = item as Record<string, unknown>
    if (
      typeof entry.name !== "string" ||
      typeof entry.canonicalPath !== "string" ||
      typeof entry.template !== "string"
    ) {
      return undefined
    }
    entries.push([
      entry.name,
      entry.canonicalPath,
      entry.description ?? null,
      entry.agent ?? null,
      entry.model ?? null,
      entry.subagent ?? null,
      entry.template,
    ])
  }

  entries.sort((left, right) => compareText(String(left[0]), String(right[0])))
  return JSON.stringify({ directory, entries })
}

interface StoredEntry {
  readonly key: string
  readonly value: Schema.Json
}

async function removePrefix(storage: StoragePort, prefix: string): Promise<void> {
  for await (const entries of pages(storage, prefix)) {
    for (const entry of entries) await storage.remove(entry.key)
  }
}

/**
 * Removes the unqualified records of every pre-location build, once (adr-exposure-02 S6).
 *
 * Unscoped by design: a legacy record has no owner to attribute it to. The marker is
 * written only after a complete sweep, so an interrupted migration is retried.
 */
async function migrateLegacy(storage: StoragePort): Promise<readonly string[]> {
  let marker: Schema.Json | undefined

  try {
    marker = await storage.get(STORAGE_FORMAT_KEY)
  } catch (error) {
    return [`migrate: ${reasonOf(error)}`]
  }

  if (marker === STORAGE_FORMAT) return []

  try {
    for (const prefix of LEGACY_STORAGE_PREFIXES) await removePrefix(storage, prefix)
  } catch (error) {
    return [`migrate: ${reasonOf(error)}`]
  }

  try {
    await storage.set(STORAGE_FORMAT_KEY, STORAGE_FORMAT)
  } catch (error) {
    return [`migrate: ${reasonOf(error)}`]
  }

  return []
}

async function scanPrefix(storage: StoragePort, prefix: string): Promise<readonly StoredEntry[]> {
  const entries: StoredEntry[] = []

  for await (const page of pages(storage, prefix)) entries.push(...page)

  return entries
}

const tokensOf = (
  entries: readonly StoredEntry[],
  prefix: string,
  location: string,
  skipKey: (key: string) => boolean,
): ReadonlySet<string> => {
  const tokens = new Set<string>()

  for (const entry of entries) {
    if (skipKey(entry.key)) continue
    const token = entry.key.slice(prefix.length)
    if (token.length === 0 || tokens.has(token)) continue
    const directory = directoryOf(entry.value)
    if (directory !== undefined && isInside(directory, location)) tokens.add(token)
  }

  return tokens
}

const skipNestedCommandManifest =
  (locationToken: string) =>
  (key: string): boolean =>
    key === STORAGE_KEYS.commandVersion(locationToken) ||
    key.startsWith(STORAGE_KEYS.commandManifest(locationToken, ""))

/**
 * The command manifest store (ADR command R16; plan PD9).
 *
 * The command counter is separate from the skill counter and moves only when the desired
 * state differs from the stored one. Pruning is in-location and must skip the keys nested
 * under the cache prefix, because `…/commands/manifest/` is pruned as `…/commands/`.
 */
export async function persistCommands(
  storage: StoragePort,
  { location, snapshots, now }: PersistCommandsInput,
): Promise<PersistCommandsResult> {
  const locationToken = locationTokenFor(location)
  let current: Schema.Json | undefined

  try {
    current = await storage.get(STORAGE_KEYS.commandVersion(locationToken))
  } catch (error) {
    return { ok: false, version: 0, written: false, pruned: 0, diagnostics: [`version: ${reasonOf(error)}`] }
  }

  const stored = toCounter(current)
  const ordered = [...snapshots].sort((left, right) => compareText(left.scopeToken, right.scopeToken))
  const desired = new Set(ordered.map((snapshot) => snapshot.scopeToken))
  let changed = false

  for (const snapshot of ordered) {
    let value: Schema.Json | undefined

    try {
      value = await storage.get(STORAGE_KEYS.commandSnapshot(locationToken, snapshot.scopeToken))
    } catch (error) {
      return {
        ok: false,
        version: stored,
        written: false,
        pruned: 0,
        diagnostics: [`snapshot: ${snapshot.scopeToken}: ${reasonOf(error)}`],
      }
    }

    if (storedSignature(value) !== commandSignature(snapshot.directory, snapshot.commands)) changed = true
  }

  if (!changed) {
    try {
      const inManifests = tokensOf(
        await scanPrefix(storage, STORAGE_KEYS.commandManifest(locationToken, "")),
        STORAGE_KEYS.commandManifest(locationToken, ""),
        location,
        () => false,
      )
      const inCaches = tokensOf(
        await scanPrefix(storage, STORAGE_KEYS.commandSnapshot(locationToken, "")),
        STORAGE_KEYS.commandSnapshot(locationToken, ""),
        location,
        skipNestedCommandManifest(locationToken),
      )
      const existing = new Set([...inManifests, ...inCaches])
      changed = existing.size !== desired.size || [...existing].some((token) => !desired.has(token))
    } catch (error) {
      return { ok: false, version: stored, written: false, pruned: 0, diagnostics: [`scan: ${reasonOf(error)}`] }
    }
  }

  let version = stored
  let written = false

  if (changed) {
    version = Math.max(stored + 1, now ?? Date.now())

    try {
      await storage.set(STORAGE_KEYS.commandVersion(locationToken), version)
    } catch (error) {
      return {
        ok: false,
        version: stored,
        written: false,
        pruned: 0,
        diagnostics: [`version: ${reasonOf(error)}`],
      }
    }

    for (const snapshot of ordered) {
      const manifest: CommandManifestRecord = {
        manifestVersion: version,
        scopeToken: snapshot.scopeToken,
        directory: snapshot.directory,
        entries: snapshot.commands.map(toCommandManifestEntry),
      }
      const cached: CommandCacheRecord = {
        manifestVersion: version,
        scopeToken: snapshot.scopeToken,
        directory: snapshot.directory,
        commands: snapshot.commands.map(toCachedCommand),
      }

      try {
        await storage.set(STORAGE_KEYS.commandManifest(locationToken, snapshot.scopeToken), asJson(manifest))
      } catch (error) {
        return {
          ok: false,
          version,
          written: true,
          pruned: 0,
          diagnostics: [`manifest: ${snapshot.scopeToken}: ${reasonOf(error)}`],
        }
      }

      try {
        await storage.set(STORAGE_KEYS.commandSnapshot(locationToken, snapshot.scopeToken), asJson(cached))
      } catch (error) {
        return {
          ok: false,
          version,
          written: true,
          pruned: 0,
          diagnostics: [`snapshot: ${snapshot.scopeToken}: ${reasonOf(error)}`],
        }
      }
    }

    written = true
  }

  const diagnostics: string[] = []
  let pruned = 0

  try {
    pruned += await prunePrefix(storage, STORAGE_KEYS.commandManifest(locationToken, ""), desired, location)
    pruned += await prunePrefix(
      storage,
      STORAGE_KEYS.commandSnapshot(locationToken, ""),
      desired,
      location,
      skipNestedCommandManifest(locationToken),
    )
  } catch (error) {
    diagnostics.push(`prune: ${reasonOf(error)}`)
    return { ok: true, version, written, pruned: 0, diagnostics }
  }

  return { ok: true, version, written, pruned, diagnostics }
}
