import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
  DEBOUNCE_MS,
  MAX_DESCRIPTION_LENGTH,
  compareText,
  MAX_NAME_LENGTH,
  PROMPT_THROTTLE_MS,
  type RegistryEntry,
  type RegistrySnapshot,
  type ScanCandidate,
  type Snapshot,
} from "./contracts.ts"
import { createBackstop, type Backstop } from "./backstop.ts"
import { indexCandidates, scopeTokenFor, type IndexedSkill } from "./indexer.ts"
import { persistRegistry } from "./manifest.ts"
import { resolveNativeRoots, type NativeRootInput } from "./native.ts"
import { composeName, sanitizeText } from "./names.ts"
import { applyRegistry } from "./replay.ts"
import { scanSkills } from "./scan.ts"
import { createDebouncer, createWatchSet, deriveWatchTargets, type WatchFactory } from "./watch.ts"

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const DIAGNOSTIC_LIMIT = 200
const DEDUPE_SETTLE_INTERVAL_MS = 50
const DEDUPE_SETTLE_MIN_MS = 750
const DEDUPE_SETTLE_TIMEOUT_MS = 1000

async function canonicalDirectory(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return resolve(target)
  }
}

async function canonicalPathOf(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

type SkillList = Awaited<ReturnType<Plugin.Context["skill"]["list"]>>

const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

const foreignIdsOf = (list: SkillList, ownedIds: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(list.data.filter((entry) => !ownedIds.has(String(entry.id))).map((entry) => String(entry.id)))

const sameIds = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((id) => right.has(id))

const containsAll = (superset: ReadonlySet<string>, subset: ReadonlySet<string>): boolean =>
  [...subset].every((id) => superset.has(id))

interface SettleInput {
  readonly read: () => Promise<SkillList>
  readonly ownedIds: ReadonlySet<string>
  readonly expected: ReadonlySet<string> | undefined
}

interface SettleResult {
  readonly list: SkillList
  readonly timedOut: boolean
  readonly elapsed: number
}

async function settleForeignTier({ read, ownedIds, expected }: SettleInput): Promise<SettleResult> {
  const minReads = Math.ceil(DEDUPE_SETTLE_MIN_MS / DEDUPE_SETTLE_INTERVAL_MS)
  const maxReads = Math.ceil(DEDUPE_SETTLE_TIMEOUT_MS / DEDUPE_SETTLE_INTERVAL_MS)
  let reads = 0
  let list = await read()
  reads += 1
  let ids = foreignIdsOf(list, ownedIds)

  if (expected === undefined && ids.size === 0) return { list, timedOut: false, elapsed: 0 }

  if (expected !== undefined && containsAll(ids, expected)) {
    const confirmation = await read()
    const confirmed = foreignIdsOf(confirmation, ownedIds)
    if (sameIds(ids, confirmed)) return { list: confirmation, timedOut: false, elapsed: 0 }
    list = confirmation
    ids = confirmed
  }

  while (reads < maxReads) {
    await delay(DEDUPE_SETTLE_INTERVAL_MS)

    const next = await read()
    reads += 1
    const nextIds = foreignIdsOf(next, ownedIds)

    const expectedPresent = expected === undefined || containsAll(nextIds, expected)

    if (sameIds(ids, nextIds) && nextIds.size > 0 && expectedPresent && reads >= minReads) {
      return { list: next, timedOut: false, elapsed: reads * DEDUPE_SETTLE_INTERVAL_MS }
    }

    list = next
    ids = nextIds
  }

  return { list, timedOut: true, elapsed: reads * DEDUPE_SETTLE_INTERVAL_MS }
}

function capDiagnostics(diagnostics: readonly string[]): readonly string[] {
  if (diagnostics.length <= DIAGNOSTIC_LIMIT) return diagnostics

  const kept = diagnostics.slice(0, DIAGNOSTIC_LIMIT - 1)
  return [...kept, `truncated: ${diagnostics.length - kept.length} more diagnostics`]
}

type StageResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }

async function runStage<T>(
  diagnostics: string[],
  name: string,
  run: () => Promise<T>,
): Promise<StageResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    diagnostics.push(`${name}: ${reasonOf(error)}`)
    return { ok: false }
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
    .sort((left, right) => compareText(left.id, right.id))
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
      .sort(([left], [right]) => compareText(left, right))
      .map(([scopeToken, group]) =>
        Object.freeze({
          scopeToken,
          directory: group.directory,
          skills: Object.freeze(
            [...group.skills]
              .sort((left, right) => compareText(left.id, right.id))
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

export interface RefreshOutcome {
  readonly ok: boolean
  readonly skills: number
  readonly subprojects: number
  readonly version?: number
  readonly reloads: number
  readonly diagnostics: readonly string[]
}

export interface Registry {
  readonly location: string
  readonly snapshot: RegistrySnapshot
  readonly outcome: RefreshOutcome
  activate(): Promise<RefreshOutcome>
  refresh(): Promise<RefreshOutcome>
  dispose(): Promise<void>
}

/**
 * Trigger wiring (PD1): opt-in, so `createRegistry(ctx)` and every F5 test keep the
 * exact no-trigger behaviour. `setup(ctx)` supplies `nodeWatchFactory` in production.
 */
export interface RegistryOptions {
  readonly watchDirectory?: WatchFactory
  readonly debounceMs?: number
  readonly throttleMs?: number
  readonly now?: () => number
}

type Registration = Awaited<ReturnType<Plugin.Context["skill"]["transform"]>>

const EMPTY_OUTCOME: RefreshOutcome = Object.freeze({
  ok: false,
  skills: 0,
  subprojects: 0,
  reloads: 0,
  diagnostics: Object.freeze([]),
})

export function selectSuppressed(
  skills: readonly RegistryEntry[],
  foreignPaths: ReadonlySet<string>,
): readonly string[] {
  const suppressed: string[] = []
  const seenPaths = new Set<string>()

  for (const entry of [...skills].sort((left, right) => compareText(left.id, right.id))) {
    if (foreignPaths.has(entry.canonicalPath) || seenPaths.has(entry.canonicalPath)) {
      suppressed.push(entry.id)
      continue
    }
    seenPaths.add(entry.canonicalPath)
  }

  return suppressed
}

function withoutEntries(
  snapshot: RegistrySnapshot,
  suppressed: ReadonlySet<string>,
): RegistrySnapshot {
  const snapshots = snapshot.snapshots
    .map((subproject) =>
      Object.freeze({
        scopeToken: subproject.scopeToken,
        directory: subproject.directory,
        skills: Object.freeze(subproject.skills.filter((entry) => !suppressed.has(entry.id))),
      }),
    )
    .filter((subproject) => subproject.skills.length > 0)

  return Object.freeze({ location: snapshot.location, snapshots: Object.freeze(snapshots) })
}

export function createRegistry(ctx: Plugin.Context, options: RegistryOptions = {}): Registry {
  let canonical: string | undefined
  let current: RegistrySnapshot = Object.freeze({
    location: resolve(ctx.location.directory),
    snapshots: Object.freeze([]),
  })
  let outcome = EMPTY_OUTCOME
  let registration: Registration | undefined
  let registering: Promise<void> | undefined
  let inFlight: Promise<RefreshOutcome> | undefined
  let disposed = false
  let followUp = false
  let settledForeignIds: ReadonlySet<string> | undefined
  const replayDiagnostics: string[] = []
  const watchDiagnostics: string[] = []

  const now = options.now ?? (() => Date.now())

  const debouncer =
    options.watchDirectory === undefined
      ? undefined
      : createDebouncer({ delayMs: options.debounceMs ?? DEBOUNCE_MS, fire: () => queue() })

  const watchers =
    options.watchDirectory === undefined
      ? undefined
      : createWatchSet({
          factory: options.watchDirectory,
          onEvent: () => debouncer?.signal(),
          onDiagnostic: (message) => {
            watchDiagnostics.push(message)
          },
        })

  let backstop: Backstop | undefined
  let backstopRegistration: Registration | undefined
  let registeringBackstop: Promise<void> | undefined

  const location = (): string => canonical ?? resolve(ctx.location.directory)

  const nativeInput = (): NativeRootInput => {
    const home = process.env.OPENCODE_TEST_HOME ?? homedir()
    const configDirectory =
      process.env.OPENCODE_CONFIG_DIR ??
      join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode")

    return { location: location(), home, configDirectory }
  }

  const record = (next: RefreshOutcome): RefreshOutcome => {
    outcome = next
    return next
  }

  const fail = (diagnostics: readonly string[], reloads = 0): RefreshOutcome => ({
    ok: false,
    skills: 0,
    subprojects: 0,
    reloads,
    diagnostics: capDiagnostics(diagnostics),
  })

  const ensureRegistered = async (): Promise<void> => {
    if (registration !== undefined || disposed) return
    if (registering === undefined) {
      registering = ctx.skill
        .transform((editor) => {
          try {
            replayDiagnostics.push(...applyRegistry(editor, current))
          } catch (error) {
            replayDiagnostics.push(`replay: ${reasonOf(error)}`)
          }
        })
        .then((created) => {
          registration = created
        })
        .finally(() => {
          registering = undefined
        })
    }
    await registering
  }

  /** Reconciles the watcher set from a successful scan. Never throws (PD7). */
  const syncWatchers = async (base: string, candidates: readonly ScanCandidate[]): Promise<void> => {
    if (disposed || watchers === undefined) return

    try {
      const derived = await deriveWatchTargets({ location: base, candidates })
      watchDiagnostics.push(...derived.diagnostics)
      watchers.sync(derived.targets)
    } catch (error) {
      watchDiagnostics.push(`watch: ${reasonOf(error)}`)
    }
  }

  /**
   * Registers the prompt backstop once (PD6). A rejected hook registration becomes a
   * `hook: <reason>` diagnostic and leaves the instance without a backstop.
   */
  const ensureBackstop = async (): Promise<void> => {
    if (backstop !== undefined || disposed || watchers === undefined) return
    if (registeringBackstop !== undefined) {
      await registeringBackstop
      return
    }

    const created = createBackstop({
      refresh: () => refresh(),
      inFlight: () => inFlight,
      throttleMs: options.throttleMs ?? PROMPT_THROTTLE_MS,
      now,
    })

    registeringBackstop = ctx.session
      .hook("prompt", () => created.prompt())
      .then((registration) => {
        backstop = created
        backstopRegistration = registration
      })
      .catch((error) => {
        watchDiagnostics.push(`hook: ${reasonOf(error)}`)
      })
      .finally(() => {
        registeringBackstop = undefined
      })

    await registeringBackstop
  }

  const queue = (): void => {
    if (disposed) return
    if (inFlight !== undefined) {
      followUp = true
      return
    }
    void refresh().catch(() => undefined)
  }

  const runRefresh = async (): Promise<RefreshOutcome> => {
    if (disposed) return record(fail(["disposed"]))

    const diagnostics: string[] = [...replayDiagnostics.splice(0), ...watchDiagnostics.splice(0)]
    const base = await canonicalDirectory(ctx.location.directory)
    canonical = base
    const nativeRoots = await resolveNativeRoots(nativeInput())

    let locationInfo
    try {
      locationInfo = await stat(base)
    } catch {
      locationInfo = undefined
    }

    if (locationInfo === undefined || !locationInfo.isDirectory()) {
      diagnostics.push(`scan: ${base} is not a directory`)
      const written = await persistRegistry(ctx.storage, { location: base, snapshots: [] })
      diagnostics.push(...written.diagnostics)
      if (!written.ok) return record(fail(diagnostics))

      current = Object.freeze({ location: base, snapshots: Object.freeze([]) })

      const reloaded = await runStage(diagnostics, "reload", () => ctx.skill.reload())
      if (!reloaded.ok) return record(fail(diagnostics))

      return record({
        ok: false,
        skills: 0,
        subprojects: 0,
        version: written.version,
        reloads: 1,
        diagnostics: capDiagnostics(diagnostics),
      })
    }

    const scanned = await runStage(diagnostics, "scan", () =>
      scanSkills({ location: base, excludeRoots: nativeRoots }),
    )
    if (!scanned.ok) return record(fail(diagnostics))
    if (scanned.value.truncated) diagnostics.push("scan-truncated")
    diagnostics.push(...scanned.value.diagnostics)
    // A good scan is a valid watcher set even if a later stage fails (PD7).
    await syncWatchers(base, scanned.value.candidates)

    const indexed = await runStage(diagnostics, "index", () =>
      indexCandidates(scanned.value.candidates, { location: base, nativeRoots }),
    )
    if (!indexed.ok) return record(fail(diagnostics))
    diagnostics.push(...indexed.value.diagnostics)

    const built = await runStage(diagnostics, "snapshot", () =>
      buildRegistrySnapshot({ location: base, skills: assembleEntries(indexed.value.skills) }),
    )
    if (!built.ok) return record(fail(diagnostics))
    diagnostics.push(...built.value.diagnostics)

    const persisted = await runStage(diagnostics, "manifest", () =>
      persistRegistry(ctx.storage, { location: base, snapshots: built.value.snapshot.snapshots }),
    )
    if (!persisted.ok) return record(fail(diagnostics))
    diagnostics.push(...persisted.value.diagnostics)
    if (!persisted.value.ok) return record(fail(diagnostics))

    current = built.value.snapshot

    const reloaded = await runStage(diagnostics, "reload", () => ctx.skill.reload())
    if (!reloaded.ok) return record(fail(diagnostics))

    let reloads = 1
    const ownedIds = new Set(current.snapshots.flatMap((subproject) => subproject.skills.map((entry) => entry.id)))
    const hasCandidates = current.snapshots.some((subproject) => subproject.skills.length > 0)

    let foreign: SkillList["data"] = []

    if (hasCandidates) {
      const settled = await runStage(diagnostics, "list", () =>
        settleForeignTier({
          read: () => ctx.skill.list(),
          ownedIds,
          expected: settledForeignIds,
        }),
      )
      if (!settled.ok) return record(fail(diagnostics, reloads))

      if (settled.value.timedOut) {
        diagnostics.push(`dedupe-settle-timeout: ${settled.value.elapsed}`)
      } else {
        settledForeignIds = foreignIdsOf(settled.value.list, ownedIds)
      }

      foreign = settled.value.list.data.filter((entry) => !ownedIds.has(String(entry.id)))
    }

    const foreignPaths = new Set(
      await Promise.all(foreign.map((entry) => canonicalPathOf(String(entry.path)))),
    )
    const suppressed = selectSuppressed(
      current.snapshots.flatMap((subproject) => subproject.skills),
      foreignPaths,
    )

    for (const id of suppressed) diagnostics.push(`dedupe: ${id}`)

    if (suppressed.length > 0) {
      const corrected = withoutEntries(current, new Set(suppressed))
      const written = await persistRegistry(ctx.storage, {
        location: base,
        snapshots: corrected.snapshots,
        version: persisted.value.version,
      })
      diagnostics.push(...written.diagnostics)
      if (!written.ok) return record(fail(diagnostics, reloads))

      current = corrected
      reloads += 1

      const correctedReload = await runStage(diagnostics, "reload", () => ctx.skill.reload())
      if (!correctedReload.ok) return record(fail(diagnostics, reloads - 1))
    }

    return record({
      ok: true,
      skills: current.snapshots.reduce((total, subproject) => total + subproject.skills.length, 0),
      subprojects: current.snapshots.length,
      version: persisted.value.version,
      reloads,
      diagnostics: capDiagnostics(diagnostics),
    })
  }

  const refresh = async (): Promise<RefreshOutcome> => {
    if (disposed) return record(fail(["disposed"]))
    if (inFlight !== undefined) return inFlight

    const run = (async () => {
      try {
        await ensureRegistered()
      } catch (error) {
        return record(fail([`register: ${reasonOf(error)}`]))
      }
      return runRefresh()
    })()

    inFlight = run
    try {
      return await run
    } finally {
      if (inFlight === run) inFlight = undefined
      // Any completed refresh suppresses the next prompt backstop (PD6).
      backstop?.observe(now())
      // Exactly one follow-up: never a queue, and never a second concurrent scan (PD4).
      if (followUp && !disposed) {
        followUp = false
        queue()
      }
    }
  }

  const activate = async (): Promise<RefreshOutcome> => {
    try {
      await ensureRegistered()
    } catch (error) {
      return record(fail([`register: ${reasonOf(error)}`]))
    }
    const activated = await refresh()
    // Built after the first refresh so activation is already recorded, and regardless of its outcome.
    await ensureBackstop()
    backstop?.observe(now())
    return activated
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    followUp = false

    debouncer?.clear()
    watchers?.dispose()
    if (inFlight !== undefined) await inFlight.catch(() => undefined)
    if (registeringBackstop !== undefined) await registeringBackstop.catch(() => undefined)

    const existingBackstop = backstopRegistration
    backstopRegistration = undefined
    if (existingBackstop !== undefined) await existingBackstop.dispose().catch(() => undefined)

    const stopped = backstop
    backstop = undefined
    if (stopped !== undefined) await stopped.dispose().catch(() => undefined)

    if (registering !== undefined) await registering.catch(() => undefined)

    const created = registration
    registration = undefined
    if (created !== undefined) await created.dispose().catch(() => undefined)
  }

  return {
    get location() {
      return location()
    },
    get snapshot() {
      return current
    },
    get outcome() {
      return outcome
    },
    activate,
    refresh,
    dispose,
  }
}
