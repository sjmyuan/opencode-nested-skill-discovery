import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
  DEBOUNCE_MS,
  MAX_DESCRIPTION_LENGTH,
  compareText,
  MAX_NAME_LENGTH,
  PROMPT_THROTTLE_MS,
  type AgentCandidate,
  type AgentConfigCandidate,
  type CommandCandidate,
  type CommandSnapshotSet,
  type RegistryEntry,
  type RegistrySnapshot,
  type ScanCandidate,
  type Snapshot,
} from "./contracts.ts"
import { createBackstop, type Backstop } from "./backstop.ts"
import { auditReloadedAgents } from "./agent-audit.ts"
import { indexAgents, type IndexedAgent } from "./agent-index.ts"
import { admitAgents, type AdmittedAgent } from "./agent-project.ts"
import { indexCandidates, scopeTokenFor, type IndexedSkill } from "./indexer.ts"
import { auditReloadedCommands, EMPTY_NATIVE_COMMANDS } from "./command-audit.ts"
import { filterCommandFamilies } from "./command-family.ts"
import { createNameLedger, type QualifiedCommand } from "./command-names.ts"
import { resolveNativeCommandNames, type NativeCommandNameIndex } from "./command-native.ts"
import { applyCommands, findCommand, type CommandExecutor } from "./command-replay.ts"
import { createShadowTracker } from "./command-shadow.ts"
import { buildCommandSnapshot } from "./command-snapshot.ts"
import { createFamilyPass } from "./family.ts"
import { persistCommands, persistRegistry } from "./manifest.ts"
import { resolveNativeAgentRoots, resolveNativeRoots, type NativeRootInput } from "./native.ts"
import { composeName, sanitizeText } from "./names.ts"
import { resolveScanLimits } from "./options.ts"
import { applyAgents, applyRegistry, type ModeSeed } from "./replay.ts"
import { scanSkills } from "./scan.ts"
import { createDebouncer, createWatchSet, deriveWatchTargets, type WatchFactory } from "./watch.ts"

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const DIAGNOSTIC_LIMIT = 200
const DEDUPE_DEFERRED_DELAYS_MS = [1500, 4000] as const

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

const foreignIdsOf = (list: SkillList, ownedIds: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(list.data.filter((entry) => !ownedIds.has(String(entry.id))).map((entry) => String(entry.id)))

const containsAll = (superset: ReadonlySet<string>, subset: ReadonlySet<string>): boolean =>
  [...subset].every((id) => superset.has(id))

type WriteGate = <T>(run: () => Promise<T>) => Promise<T>

const createWriteGate = (): WriteGate => {
  let tail: Promise<void> = Promise.resolve()

  return async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release: () => void = () => {}
    tail = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }
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
  readonly commands: number
  readonly commandReloads: number
  readonly diagnostics: readonly string[]
}

export interface Registry {
  readonly location: string
  readonly snapshot: RegistrySnapshot
  readonly outcome: RefreshOutcome
  /** The last successfully indexed agents (both sources), in ID order; `[]` before the first. */
  readonly agents: readonly IndexedAgent[]
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
  readonly executeCommand?: CommandExecutor
}

type Registration = Awaited<ReturnType<Plugin.Context["skill"]["transform"]>>

const EMPTY_OUTCOME: RefreshOutcome = Object.freeze({
  ok: false,
  skills: 0,
  subprojects: 0,
  reloads: 0,
  commands: 0,
  commandReloads: 0,
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
  let currentAgents: readonly IndexedAgent[] = []
  let currentCommands: CommandSnapshotSet | undefined
  let registration: Registration | undefined
  let registering: Promise<void> | undefined
  let commandRegistration: Registration | undefined
  let registeringCommand: Promise<void> | undefined
  let agentRegistration: Registration | undefined
  let registeringAgent: Promise<void> | undefined
  /** One-shot `agent-register:` report: a rejected transform is retried on the next refresh. */
  let agentRegisterReported = false
  let currentAgentPayload: readonly AdmittedAgent[] | undefined
  let agentSeeded = false
  /** The same read's `mode`/`hidden` per native name; never re-read after the transform (G4). */
  let agentSeed: ModeSeed = new Map()
  let seeded = false
  let inFlight: Promise<RefreshOutcome> | undefined
  let disposed = false
  let followUp = false
  let settledForeignIds: ReadonlySet<string> | undefined
  let dedupeGeneration = 0
  let deferredTimers: ReturnType<typeof setTimeout>[] = []
  let deferredRunning = false
  let deferredCorrected = false
  const deferredDiagnostics: string[] = []
  const replayDiagnostics: string[] = []
  const commandDiagnostics: string[] = []
  const agentDiagnostics: string[] = []
  const watchDiagnostics: string[] = []
  /** IDs the host map held when the transform registered, grown by the reload audit (G8, G9). */
  const heldAgents = new Set<string>()
  /** The subset the audit reported, so the skip says why the ID is held (D10). */
  const shadowedAgents = new Set<string>()
  const nameLedger = createNameLedger()
  const shadowTracker = createShadowTracker()

  /** The pre-registration listing read; it repeats only when the whole registration was retried (R4). */
  const seedPrePhaseNames = async (): Promise<void> => {
    if (seeded) return
    try {
      const listed = await ctx.command.list()
      shadowTracker.seed(listed.data.map((entry) => String(entry.name)))
      seeded = true
    } catch (error) {
      commandDiagnostics.push(`command-seed: ${reasonOf(error)}`)
    }
  }

  /**
   * The pre-registration agent listing (ADR agent G8, C4): read once, before the transform
   * exists. A post-registration read would hold our own entries, so it is never re-read —
   * the audit grows the set afterwards instead (D6). This read also seeds G4's native-name
   * map, because a later read would offer our own entries as inherit targets.
   */
  const seedHeldAgents = async (): Promise<void> => {
    if (agentSeeded) return
    const listed = await runStage(agentDiagnostics, "agent-seed", () => ctx.agent.list())
    if (!listed.ok) return
    const rows = listed.value.data
    for (const entry of rows) heldAgents.add(String(entry.id))
    agentSeed = new Map(
      rows
        .filter((entry) => !String(entry.id).startsWith("nested."))
        .map((entry) => [String(entry.id), { mode: entry.mode, hidden: entry.hidden }] as const),
    )
    agentSeeded = true
  }

  const now = options.now ?? (() => Date.now())
  const executeCommand = options.executeCommand
  const withWriteGate = createWriteGate()
  // Resolved once per instance: the host options are fixed for the registry's life (ADR R8).
  const scanLimits = resolveScanLimits(ctx.options)

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
    commands: 0,
    commandReloads: 0,
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

  /** One early command transform (ADR command R14; plan PD4). A rejection never blocks skills. */
  const ensureCommandRegistered = async (): Promise<void> => {
    if (commandRegistration !== undefined || disposed) return

    try {
      if (registeringCommand === undefined) {
        registeringCommand = (async () => {
          await seedPrePhaseNames()
          return ctx.command.transform((editor) => {
            try {
              commandDiagnostics.push(
                ...applyCommands(editor, currentCommands, {
                  lookup: (name) => findCommand(currentCommands, name),
                  ...(executeCommand === undefined ? {} : { execute: executeCommand }),
                }),
              )
            } catch (error) {
              commandDiagnostics.push(`command-replay: ${reasonOf(error)}`)
            }
          })
        })()
          .then((created) => {
            commandRegistration = created
          })
          .catch((error) => {
            commandDiagnostics.push(`command-register: ${reasonOf(error)}`)
          })
          .finally(() => {
            registeringCommand = undefined
          })
      }
      await registeringCommand
    } catch (error) {
      commandDiagnostics.push(`command-register: ${reasonOf(error)}`)
    }
  }

  /**
   * One early agent transform (ADR agent G1; C3). A rejection never blocks skills or commands
   * and is reported once, not made final: the next refresh retries the registration with the
   * fresh payload, so one transient host rejection does not cost the instance its agents.
   */
  const ensureAgentRegistered = async (): Promise<void> => {
    if (agentRegistration !== undefined || disposed) return

    const reportFailure = (error: unknown): void => {
      if (agentRegisterReported) return
      agentRegisterReported = true
      agentDiagnostics.push(`agent-register: ${reasonOf(error)}`)
    }

    try {
      if (registeringAgent === undefined) {
        registeringAgent = (async () => {
          await seedHeldAgents()
          return ctx.agent.transform((editor) => {
            try {
              agentDiagnostics.push(...applyAgents(editor, currentAgentPayload, agentSeed))
            } catch (error) {
              // Never rethrow: a throw here escapes into the host's replay loop, which disables
              // the whole plugin group — skills and commands with it.
              agentDiagnostics.push(`agent-replay: payload: ${reasonOf(error)}`)
            }
          })
        })()
          .then((created) => {
            agentRegistration = created
          })
          .catch(reportFailure)
          .finally(() => {
            registeringAgent = undefined
          })
      }
      await registeringAgent
    } catch (error) { // unreachable: registeringAgent ends in .catch(reportFailure)
      reportFailure(error)
    }
  }

  /** Reconciles the watcher set from a successful scan. Never throws (PD7). */
  const syncWatchers = async (
    base: string,
    candidates: readonly ScanCandidate[],
    commands: readonly CommandCandidate[],
    agents: readonly AgentCandidate[],
    agentConfigs: readonly AgentConfigCandidate[],
  ): Promise<void> => {
    if (disposed || watchers === undefined) return

    try {
      const derived = await deriveWatchTargets({ location: base, candidates, commands, agents, agentConfigs })
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

    dedupeGeneration += 1
    clearDeferredTimers()

    const diagnostics: string[] = [
      ...scanLimits.diagnostics,
      ...replayDiagnostics.splice(0),
      ...commandDiagnostics.splice(0),
      ...agentDiagnostics.splice(0),
      ...deferredDiagnostics.splice(0),
      ...watchDiagnostics.splice(0),
    ]
    const base = await canonicalDirectory(ctx.location.directory)
    canonical = base
    const nativeRoots = await resolveNativeRoots(nativeInput())
    // A5: the same ancestor sweep, for the native agent roots the scan must not re-publish.
    const agentNativeRoots = await resolveNativeAgentRoots(nativeInput())

    let locationInfo
    try {
      locationInfo = await stat(base)
    } catch {
      locationInfo = undefined
    }

    if (locationInfo === undefined || !locationInfo.isDirectory()) {
      diagnostics.push(`scan: ${base} is not a directory`)
      const written = await withWriteGate(async () => {
        const result = await persistRegistry(ctx.storage, { location: base, snapshots: [] })
        if (result.ok) current = Object.freeze({ location: base, snapshots: Object.freeze([]) })
        return result
      })
      diagnostics.push(...written.diagnostics)
      if (!written.ok) return record(fail(diagnostics))

      const clearedCommands = await withWriteGate(async () => {
        const result = await persistCommands(ctx.storage, { location: base, snapshots: [] })
        if (result.ok) {
          currentCommands = Object.freeze({ location: base, snapshots: Object.freeze([]) })
        }
        return result
      })
      for (const line of clearedCommands.diagnostics) diagnostics.push(`command-persist: ${line}`)

      const commandReloaded = await runStage(diagnostics, "command-reload", () => ctx.command.reload())
      currentAgentPayload = Object.freeze([])
      await runStage(diagnostics, "agent-reload", () => ctx.agent.reload())

      const reloaded = await runStage(diagnostics, "reload", () => ctx.skill.reload())
      if (!reloaded.ok) return record(fail(diagnostics))

      return record({
        ok: false,
        skills: 0,
        subprojects: 0,
        version: written.version,
        reloads: 1,
        commands: 0,
        commandReloads: commandReloaded.ok ? 1 : 0,
        diagnostics: capDiagnostics(diagnostics),
      })
    }

    const scanned = await runStage(diagnostics, "scan", () =>
      scanSkills({
        location: base,
        excludeRoots: nativeRoots,
        agentNativeRoots,
        limits: scanLimits.limits,
      }),
    )
    if (!scanned.ok) return record(fail(diagnostics))
    if (scanned.value.truncated) diagnostics.push("scan-truncated")
    diagnostics.push(...scanned.value.diagnostics)
    // A good scan is a valid watcher set even if a later stage fails (PD7). Command candidates
    // are the pre-suppression list, so a family flip opens and closes no handle (PD3).
    await syncWatchers(
      base,
      scanned.value.candidates,
      scanned.value.commands,
      scanned.value.agents,
      scanned.value.agentConfigs,
    )

    // One family pass per refresh, shared with the skill indexer and the agent index inside
    // the existing index stage (ADR command R8, agent A11). Publication composes the
    // survivors' names later.
    const indexed = await runStage(diagnostics, "index", async () => {
      const commands = scanned.value.commands
      const agentCandidates = scanned.value.agents
      const agentConfigs = scanned.value.agentConfigs
      const family =
        scanned.value.candidates.length + commands.length + agentCandidates.length + agentConfigs.length > 0
          ? await createFamilyPass(base)
          : undefined
      const skills = await indexCandidates(scanned.value.candidates, { location: base, nativeRoots, family })
      // A15: the agent stage never fails the refresh — a throw costs one diagnostic and
      // leaves the previous agent list and payload published. `agentsFresh` is what makes
      // that true: a successful index always publishes (even `[]`), a throw suppresses the
      // assignment.
      let agents: readonly IndexedAgent[] = []
      let agentsFresh = true
      let agentLines: readonly string[] = []
      let admitted: readonly AdmittedAgent[] = Object.freeze([])
      try {
        if (agentCandidates.length + agentConfigs.length > 0) {
          const indexedAgents = await indexAgents({
            location: base,
            home: nativeInput().home,
            agents: agentCandidates,
            configs: agentConfigs,
            limits: scanLimits.limits,
            ...(family === undefined ? {} : { family }),
          })
          agents = indexedAgents.agents
          agentLines = indexedAgents.diagnostics
        }
        // One projection per successful index, frozen before the transform can read it, so the
        // replay performs no I/O (G1) and a rebuild never mutates what is being replayed. The
        // freeze is shallow: the array and each entry, not the nested rules array, which the
        // replay only reads and never edits.
        const projected = admitAgents({
          agents,
          home: nativeInput().home,
          held: heldAgents,
          shadowed: shadowedAgents,
          display: (path) => relative(base, path).split(sep).join("/"),
        })
        admitted = Object.freeze(projected.admitted.map((entry) => Object.freeze(entry)))
        const overlays = admitted
          .filter((entry) => Object.keys(entry.request.headers).length + Object.keys(entry.request.body).length > 0)
          .map((entry) => `agent-request: ${entry.id}`)
        agentLines = [...agentLines, ...projected.diagnostics, ...overlays]
      } catch (error) {
        agentsFresh = false
        agentLines = [`agent-index: ${reasonOf(error)}`]
      }
      if (family === undefined || commands.length === 0) {
        return {
          skills: skills.skills,
          commands,
          diagnostics: [...skills.diagnostics, ...agentLines],
          agents,
          agentsFresh,
          admitted,
        }
      }
      const filtered = await filterCommandFamilies(commands, { family })
      return {
        skills: skills.skills,
        commands: filtered.commands,
        diagnostics: [...skills.diagnostics, ...filtered.diagnostics, ...agentLines],
        agents,
        agentsFresh,
        admitted,
      }
    })
    if (!indexed.ok) return record(fail(diagnostics))
    if (indexed.value.agentsFresh) {
      currentAgents = indexed.value.agents
      currentAgentPayload = indexed.value.admitted
    }
    diagnostics.push(...indexed.value.diagnostics)

    const built = await runStage(diagnostics, "snapshot", () =>
      buildRegistrySnapshot({ location: base, skills: assembleEntries(indexed.value.skills) }),
    )
    if (!built.ok) return record(fail(diagnostics))
    diagnostics.push(...built.value.diagnostics)

    const persisted = await runStage(diagnostics, "manifest", () =>
      withWriteGate(async () => {
        const written = await persistRegistry(ctx.storage, {
          location: base,
          snapshots: built.value.snapshot.snapshots,
        })
        if (written.ok) current = built.value.snapshot
        return written
      }),
    )
    if (!persisted.ok) return record(fail(diagnostics))
    diagnostics.push(...persisted.value.diagnostics)
    if (!persisted.value.ok) return record(fail(diagnostics))

    // Command publication is non-fatal throughout (ADR command R17): a native-walk,
    // read, persist or reload failure costs a diagnostic, never the skill reload.
    let nativeIndex: NativeCommandNameIndex | undefined
    const commandIndex = await runStage(diagnostics, "command-index", async () => {
      const planned = indexed.value.commands
      if (planned.length === 0) {
        return { commands: [] as readonly QualifiedCommand[], diagnostics: [] as readonly string[] }
      }

      const composed = nameLedger.compose(planned, base)
      const native = await resolveNativeCommandNames(nativeInput(), scanLimits.limits)
      nativeIndex = native
      const dropped = shadowTracker.drop(
        composed.commands.map((command) => ({ ...command, name: command.publishedName })),
        native,
      )

      return { commands: dropped.kept, diagnostics: [...composed.diagnostics, ...dropped.diagnostics] }
    })

    let plannedCommands: readonly QualifiedCommand[] = []
    if (commandIndex.ok) {
      plannedCommands = commandIndex.value.commands
      diagnostics.push(...commandIndex.value.diagnostics)
    }

    // A failed composition keeps the previous command snapshot: an empty planned list is
    // "nothing published", a failed one is "unknown", and only the first may clear commands.
    if (commandIndex.ok) {
      const commandSnapshot = await runStage(diagnostics, "command-snapshot", () =>
        buildCommandSnapshot({ location: base, commands: plannedCommands }),
      )
      if (commandSnapshot.ok) diagnostics.push(...commandSnapshot.value.diagnostics)

      if (commandSnapshot.ok) {
        const commandPersisted = await runStage(diagnostics, "command-persist", () =>
          withWriteGate(async () => {
            const result = await persistCommands(ctx.storage, {
              location: base,
              snapshots: commandSnapshot.value.snapshot.snapshots,
            })
            if (result.ok) currentCommands = commandSnapshot.value.snapshot
            return result
          }),
        )
        if (commandPersisted.ok) {
          for (const line of commandPersisted.value.diagnostics) diagnostics.push(`command-persist: ${line}`)
        }
      }
    }

    // F9: audit `ctx.command.list()` once this reload settles, before reporting a shadow.
    const commandReloaded = await runStage(diagnostics, "command-reload", () => ctx.command.reload())

    // The map rebuilds from the transform on reload, so one reload publishes the swap (G1).
    const agentReloaded = await runStage(diagnostics, "agent-reload", () => ctx.agent.reload())

    // G8, G9: compare the reloaded field set with what we replayed. A mismatch is reported
    // once and held out of the next projection, which then omits it from the map. Never audit
    // a payload the transform never replayed: with the registration rejected, every entry is
    // absent, and holding them all out would defeat the retry on the next refresh.
    if (agentReloaded.ok && currentAgentPayload !== undefined && agentRegistration !== undefined) {
      const payload = currentAgentPayload
      const audited = await runStage(diagnostics, "agent-audit", () =>
        auditReloadedAgents({
          agents: payload,
          shadowed: shadowedAgents,
          seed: agentSeed,
          list: () => ctx.agent.list(),
        }),
      )
      if (audited.ok) {
        diagnostics.push(...audited.value.diagnostics)
        for (const id of audited.value.shadowed) {
          heldAgents.add(id)
          shadowedAgents.add(id)
        }
      }
    }

    // F9 (ADR command R4): after the reload settles, classify the listing against the
    // snapshot we just replayed. A shadow is reported here and denied for the next snapshot.
    if (commandIndex.ok && commandReloaded.ok && currentCommands !== undefined) {
      const snapshot = currentCommands
      const audited = await runStage(diagnostics, "command-audit", () =>
        auditReloadedCommands({
          snapshot,
          list: () => ctx.command.list(),
          native: nativeIndex ?? EMPTY_NATIVE_COMMANDS,
          tracker: shadowTracker,
        }),
      )
      if (audited.ok) diagnostics.push(...audited.value.diagnostics)
    }

    const reloaded = await runStage(diagnostics, "reload", () => ctx.skill.reload())
    if (!reloaded.ok) return record(fail(diagnostics))

    let reloads = 1
    const ownedIds = new Set(current.snapshots.flatMap((subproject) => subproject.skills.map((entry) => entry.id)))
    const hadCandidates = current.snapshots.some((subproject) => subproject.skills.length > 0)
    const previousExpected = settledForeignIds

    let foreign: SkillList["data"] = []
    let foreignIds: ReadonlySet<string> | undefined

    if (hadCandidates) {
      const listed = await runStage(diagnostics, "list", () => ctx.skill.list())
      if (!listed.ok) return record(fail(diagnostics, reloads))

      foreignIds = foreignIdsOf(listed.value, ownedIds)
      settledForeignIds = foreignIds
      foreign = listed.value.data.filter((entry) => !ownedIds.has(String(entry.id)))
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
      const written = await withWriteGate(async () => {
        const result = await persistRegistry(ctx.storage, {
          location: base,
          snapshots: corrected.snapshots,
          version: persisted.value.version,
        })
        if (!result.ok) return result
        current = corrected
        reloads += 1
        return result
      })
      diagnostics.push(...written.diagnostics)
      if (!written.ok) return record(fail(diagnostics, reloads))

      const correctedReload = await runStage(diagnostics, "reload", () => ctx.skill.reload())
      if (!correctedReload.ok) return record(fail(diagnostics, reloads - 1))
    }

    const hasNested = current.snapshots.some((subproject) => subproject.skills.length > 0)
    const incomplete =
      foreignIds !== undefined &&
      (foreignIds.size === 0
        ? (previousExpected?.size ?? 0) > 0
        : previousExpected === undefined || !containsAll(foreignIds, previousExpected))

    if (hasNested && incomplete) {
      scheduleDeferredDedupe(dedupeGeneration, base, persisted.value.version, reloads === 1)
    }

    return record({
      ok: true,
      skills: current.snapshots.reduce((total, subproject) => total + subproject.skills.length, 0),
      subprojects: current.snapshots.length,
      version: persisted.value.version,
      reloads,
      commands:
        currentCommands === undefined
          ? 0
          : currentCommands.snapshots.reduce((total, subproject) => total + subproject.commands.length, 0),
      commandReloads: commandReloaded.ok ? 1 : 0,
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
      await ensureCommandRegistered()
      await ensureAgentRegistered()
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
    await ensureCommandRegistered()
    await ensureAgentRegistered()
    const activated = await refresh()
    // Built after the first refresh so activation is already recorded, and regardless of its outcome.
    await ensureBackstop()
    backstop?.observe(now())
    return activated
  }

  function clearDeferredTimers(): void {
    for (const timer of deferredTimers) clearTimeout(timer)
    deferredTimers = []
  }

  function scheduleDeferredDedupe(
    generation: number,
    base: string,
    version: number,
    allowCorrection: boolean,
  ): void {
    deferredCorrected = false

    for (const delayMs of DEDUPE_DEFERRED_DELAYS_MS) {
      const timer = setTimeout(
        () => runDeferredCheck(generation, base, version, allowCorrection).catch(() => undefined),
        delayMs,
      )
      timer.unref?.()
      deferredTimers.push(timer)
    }
  }

  async function runDeferredCheck(
    generation: number,
    base: string,
    version: number,
    allowCorrection: boolean,
  ): Promise<void> {
    if (disposed || generation !== dedupeGeneration || inFlight !== undefined || deferredRunning) return
    deferredRunning = true

    try {
      const before = current
      const listed = await ctx.skill.list()
      const ownedIds = new Set(
        before.snapshots.flatMap((subproject) => subproject.skills.map((entry) => entry.id)),
      )
      settledForeignIds = foreignIdsOf(listed, ownedIds)

      if (!allowCorrection || deferredCorrected) return
      if (disposed || generation !== dedupeGeneration || inFlight !== undefined || current !== before) return

      const foreign = listed.data.filter((entry) => !ownedIds.has(String(entry.id)))
      const foreignPaths = new Set(
        await Promise.all(foreign.map((entry) => canonicalPathOf(String(entry.path)))),
      )
      if (disposed || generation !== dedupeGeneration || inFlight !== undefined || current !== before) return
      const suppressed = selectSuppressed(
        before.snapshots.flatMap((subproject) => subproject.skills),
        foreignPaths,
      )
      if (suppressed.length === 0) return

      const corrected = withoutEntries(before, new Set(suppressed))
      let applied = false
      await withWriteGate(async () => {
        if (disposed || generation !== dedupeGeneration || inFlight !== undefined || current !== before) return

        const written = await persistRegistry(ctx.storage, {
          location: base,
          snapshots: corrected.snapshots,
          version,
        })
        if (!written.ok) {
          deferredDiagnostics.push(...written.diagnostics)
          return
        }

        current = corrected
        deferredCorrected = true
        applied = true
      })

      if (applied) await ctx.skill.reload()
    } catch (error) {
      deferredDiagnostics.push(`dedupe-deferred: ${reasonOf(error)}`)
    } finally {
      deferredRunning = false
    }
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    followUp = false
    dedupeGeneration += 1
    clearDeferredTimers()

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

    if (registeringCommand !== undefined) await registeringCommand.catch(() => undefined)

    const createdCommand = commandRegistration
    commandRegistration = undefined
    if (createdCommand !== undefined) await createdCommand.dispose().catch(() => undefined)

    if (registeringAgent !== undefined) await registeringAgent.catch(() => undefined)

    const createdAgent = agentRegistration
    agentRegistration = undefined
    if (createdAgent !== undefined) await createdAgent.dispose().catch(() => undefined)
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
    get agents() {
      return currentAgents
    },
    activate,
    refresh,
    dispose,
  }
}
