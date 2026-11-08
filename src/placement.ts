import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import type { JsonSchema } from "effect"
import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { compareText } from "./contracts.ts"
import type { RegistrySnapshot } from "./contracts.ts"

/**
 * Placement narrows the child to its destination, so the host stays cut down to the
 * domains placement needs: no permission surface is reachable from here (ADR-exposure-02 D1).
 */
export interface PlacementHost {
  readonly location: Pick<Plugin.Context["location"], "directory" | "project">
  readonly tool: Pick<Plugin.Context["tool"], "transform">
  readonly session: Pick<Plugin.Context["session"], "get" | "move">
  readonly worktree: Pick<Plugin.Context["worktree"], "list">
}

type PlacementEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
export type PlacementTool = NonNullable<ReturnType<PlacementEditor["get"]>>
type PlacementExecute = PlacementTool["execute"]
type PlacementContext = Parameters<PlacementExecute>[1]
type SessionID = Parameters<PlacementHost["session"]["get"]>[0]["sessionID"]
type SessionDirectory = Parameters<PlacementHost["session"]["move"]>[0]["directory"]

export interface PlacementOptions {
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly home?: string
}

export interface Placement {
  activate(): Promise<void>
  dispose(): Promise<void>
  readonly diagnostics: readonly string[]
}

export const GUIDANCE = [
  "directory optionally places the child before this task is admitted, so the first request is assembled from that location.",
  "Absolute paths are used directly; relative paths resolve from the calling session's current directory and a leading ~ expands to the home directory.",
  "The destination must be inside this project or one of its worktrees.",
  "A placed child narrows to the destination's instructions, skills, same-id agents, config and permissions, and loses sibling subprojects.",
  "With sessionID a different directory moves the child again at the next boundary; history is preserved, but relative paths in it are not rewritten.",
  "A refused destination creates no child. A failure after the child exists leaves it created and unprompted, and is not rolled back.",
].join("\n")

const DIRECTORY_PROPERTY: JsonSchema.JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    'Optional working directory for the child. Absolute, or relative to the calling session; a leading "~" expands to the home directory. The child moves before this task is admitted, so its first request runs there.',
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Effect codecs become JSON Schema; an already-JSON schema is only checked for shape. */
export function extendInput(input: unknown): JsonSchema.JsonSchema {
  const document = Schema.isSchema(input) ? Schema.toJsonSchemaDocument(input) : undefined
  const json = isObject(document)
    ? {
        ...document.schema,
        ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
      }
    : input
  if (!isObject(json) || json.type !== "object" || !isObject(json.properties)) {
    throw new Error("native subagent input is not an object schema")
  }
  if ("directory" in json.properties) throw new Error("native subagent input already declares directory")
  return {
    ...json,
    properties: { ...json.properties, directory: DIRECTORY_PROPERTY },
  } as JsonSchema.JsonSchema
}

export function extendDescription(description: string): string {
  return description.endsWith(GUIDANCE) ? description : `${description}\n\n${GUIDANCE}`
}

export type PlacementResolution =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly directory: string; readonly reason: string }
  | { readonly kind: "resolved"; readonly directory: string }

export interface ResolvePlacementInput {
  readonly directory: unknown
  readonly caller: string
  readonly home: string
}

/** Same expansion the host applies to a file read: `~`, `~/x`, then resolve against the caller. */
export async function resolvePlacement(input: ResolvePlacementInput): Promise<PlacementResolution> {
  const value = input.directory
  if (value === undefined || value === "") return { kind: "absent" }
  if (typeof value !== "string") {
    return { kind: "refused", directory: String(value), reason: "directory must be a string" }
  }
  if (value.trim() === "") return { kind: "refused", directory: value, reason: "directory is blank" }
  const expanded =
    value === "~" ? input.home : value.startsWith("~/") ? path.join(input.home, value.slice(2)) : value
  const directory = path.resolve(input.caller, expanded)

  try {
    const info = await stat(directory)
    if (!info.isDirectory()) return { kind: "refused", directory, reason: "not a directory" }
  } catch {
    return { kind: "refused", directory, reason: "directory does not exist" }
  }
  return { kind: "resolved", directory: await realpath(directory) }
}

export interface BoundaryInput {
  readonly destination: string
  readonly location: string
  readonly project: string
  readonly worktrees: readonly string[]
}

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** The set `FileAccess.resolve` treats as internal: the location, the project, its worktrees. */
export function withinBoundary(input: BoundaryInput): boolean {
  if (isInside(input.location, input.destination)) return true
  const root = path.parse(input.project).root
  if (input.project !== root && isInside(input.project, input.destination)) return true
  return input.worktrees.some((worktree) => isInside(worktree, input.destination))
}

/**
 * The indexed nested entries the destination owns: scopes at the destination or below it.
 * A containing scope is excluded, because its entries are advertised natively there.
 */
export function nestedIDsUnder(snapshot: RegistrySnapshot, destination: string): readonly string[] {
  const ids = new Set<string>()
  for (const scope of snapshot.snapshots) {
    if (!isInside(destination, scope.directory)) continue
    for (const skill of scope.skills) ids.add(skill.id)
  }
  return [...ids].sort(compareText)
}

const PLACEMENT_TIMEOUT_MS = 120_000
const MOVE_POLL_MS = 50

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type WaitResult<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }

/** One budget covers the move call and confirmation, because the host probes the destination inside it. */
const waitWithBudget = async <T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<WaitResult<T>> => {
  work.catch(() => undefined)
  if (signal?.aborted === true) return { kind: "aborted" }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: WaitResult<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, ms))
    const onAbort = (): void => finish({ kind: "aborted" })
    signal?.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => finish({ kind: "done", value }),
      (error) => finish({ kind: "rejected", error }),
    )
  })
}

const childOf = (update: unknown): string | undefined => {
  if (!isObject(update) || update.status !== "running") return undefined
  return typeof update.sessionID === "string" && update.sessionID !== "" ? update.sessionID : undefined
}

const directoryOf = (session: unknown): string | undefined => {
  if (!isObject(session) || !isObject(session.location)) return undefined
  const directory = session.location.directory
  return typeof directory === "string" && directory !== "" ? directory : undefined
}

const busyOf = (session: unknown): unknown => (isObject(session) && isObject(session.time) ? session.time.busy : undefined)

const placeFailure = (child: string, requested: string, observed: string, detail: string, cause?: unknown): Error =>
  new Error(
    `Subagent placement failed (child session: ${child}, requested directory: ${requested}, observed location: ${observed}). ${detail} The child stays created and unprompted; nothing was rolled back.`,
    cause === undefined ? undefined : { cause },
  )

export function createPlacement(host: PlacementHost, options: PlacementOptions = {}): Placement {
  const diagnostics: string[] = []
  const timeoutMs = options.timeoutMs ?? PLACEMENT_TIMEOUT_MS
  const pollMs = options.pollMs ?? MOVE_POLL_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const home = options.home ?? process.env.HOME ?? homedir()
  let registration: { dispose: () => Promise<void> | void } | undefined
  let disposed = false

  const skip = (reason: string): void => {
    const line = `placement: ${reason}`
    if (!diagnostics.includes(line)) diagnostics.push(line)
  }

  const readSession = async (sessionID: string): Promise<Record<string, unknown> | undefined> => {
    try {
      return (await host.session.get({ sessionID: sessionID as SessionID })) as unknown as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  const worktrees = async (): Promise<readonly string[]> => {
    try {
      const entries = await host.worktree.list({ projectID: host.location.project.id })
      return entries.map((entry) => String(entry.directory))
    } catch {
      return []
    }
  }

  const placeChild = async (
    childSessionID: string,
    destination: string,
    beforeBusy: unknown,
    beforeKnown: boolean,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const first = await readSession(childSessionID)
    const observed = directoryOf(first) ?? "unknown"
    if (busyOf(first) !== beforeBusy) {
      throw placeFailure(
        childSessionID,
        destination,
        observed,
        beforeKnown
          ? "The child had already started before it could be placed."
          : "The child's state could not be read before the task started, so placement could not confirm it was still unprompted.",
      )
    }
    if (observed === destination) return

    // The deadline starts before `move`: probing and booting the destination graph happens inside it.
    const deadline = now() + timeoutMs
    const moved = await waitWithBudget(
      host.session.move({ sessionID: childSessionID as SessionID, directory: destination as SessionDirectory }),
      deadline - now(),
      signal,
    )
    if (moved.kind === "aborted") {
      throw placeFailure(childSessionID, destination, observed, "The call was aborted before the move was confirmed.")
    }
    if (moved.kind === "timeout") {
      throw placeFailure(
        childSessionID,
        destination,
        observed,
        `The move was not confirmed within ${timeoutMs}ms; it may still be queued.`,
      )
    }
    if (moved.kind === "rejected") {
      throw placeFailure(childSessionID, destination, observed, "The move request was rejected.", moved.error)
    }

    let current = directoryOf(await readSession(childSessionID)) ?? "unknown"
    while (current !== destination) {
      if (now() >= deadline) {
        throw placeFailure(
          childSessionID,
          destination,
          current,
          `The move was not confirmed within ${timeoutMs}ms; it may still be queued.`,
        )
      }
      try {
        const waited = await waitWithBudget(sleep(pollMs), pollMs, signal)
        if (waited.kind === "aborted") throw new Error("aborted")
      } catch {
        throw placeFailure(childSessionID, destination, current, "The call was aborted before the move was confirmed.")
      }
      current = directoryOf(await readSession(childSessionID)) ?? "unknown"
    }
  }

  const route = async (
    native: PlacementExecute,
    raw: Parameters<PlacementExecute>[0],
    context: PlacementContext,
  ): Promise<Awaited<ReturnType<PlacementExecute>>> => {
    const source = isObject(raw) ? raw : {}
    const requested = source.directory
    const strip = (value: unknown): unknown => {
      if (!isObject(value) || !("directory" in value)) return value
      const { directory: _ignored, ...rest } = value
      return rest
    }
    const passThrough = (): Promise<Awaited<ReturnType<PlacementExecute>>> =>
      native(strip(raw) as Parameters<PlacementExecute>[0], context)

    if (requested === undefined || requested === "") return passThrough()

    const resolution = await resolvePlacement({ directory: requested, caller: host.location.directory, home })
    if (resolution.kind === "absent") return passThrough()
    if (resolution.kind === "refused") {
      throw new Error(
        `Subagent placement refused (requested directory: ${resolution.directory}): ${resolution.reason}. The child was not created.`,
      )
    }
    const destination = resolution.directory
    const inside = withinBoundary({
      destination,
      location: host.location.directory,
      project: host.location.project.directory,
      worktrees: await worktrees(),
    })
    if (!inside) {
      throw new Error(
        `Subagent placement refused (requested directory: ${destination}): the destination is outside this project and its worktrees. The child was not created.`,
      )
    }

    const continuation =
      typeof source.sessionID === "string" && source.sessionID !== "" ? source.sessionID : undefined
    const before = continuation === undefined ? undefined : await readSession(continuation)
    const beforeKnown = continuation === undefined || before !== undefined
    const beforeBusy = busyOf(before)

    let placed = false
    const progress: PlacementContext["progress"] = async (update) => {
      const child = placed ? undefined : childOf(update)
      if (child !== undefined) {
        await placeChild(child, destination, beforeBusy, beforeKnown, context.signal)
        placed = true
      }
      await context.progress(update)
    }

    const result = await native(strip(raw) as Parameters<PlacementExecute>[0], { ...context, progress })
    if (!placed) {
      throw new Error(
        "Native subagent did not report its child before prompting; placement was not attempted and this host version needs review. The child stays created and was prompted at its original location.",
      )
    }
    return result
  }

  const wrapExecute =
    (execute: PlacementExecute): PlacementExecute =>
    (raw, context) =>
      route(execute, raw, context)

  return {
    get diagnostics() {
      return diagnostics
    },

    async activate() {
      if (registration !== undefined || disposed) return
      try {
        registration = await host.tool.transform((editor) => {
          try {
            const native = editor.get("subagent")
            if (native === undefined) {
              skip("subagent tool is not registered")
              return
            }
            const input = extendInput(native.input)
            const description = extendDescription(native.description)
            const execute = native.execute
            editor.update("subagent", (tool) => {
              tool.input = input
              tool.description = description
              tool.execute = wrapExecute(execute)
            })
          } catch (error) {
            skip(reasonOf(error))
          }
        })
      } catch (error) {
        skip(`register: ${reasonOf(error)}`)
      }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      const current = registration
      registration = undefined
      try {
        await current?.dispose()
      } catch (error) {
        skip(`dispose: ${reasonOf(error)}`)
      }
    },
  }
}
