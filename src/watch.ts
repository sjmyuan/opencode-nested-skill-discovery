import { watch } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { PRUNE_DIRECTORIES, compareText } from "./contracts.ts"
import type { ScanCandidate, SkillRootKind } from "./contracts.ts"

/**
 * R16 watcher set (F6 PD2): one non-recursive `fs.watch` per location root, per
 * subproject that owns candidates, per candidate's skill root, and per candidate's
 * own directory. The set is derived from the last successful scan and reconciled on
 * every refresh, so a moved or deleted subproject never leaks a handle.
 */

export interface WatchHandle {
  close(): void
}

export type WatchFactory = (directory: string, onChange: () => void) => WatchHandle

/**
 * The production factory (PD10): one non-recursive `fs.watch` per directory.
 * `persistent: false` keeps the host from being held open, and the `error` listener
 * keeps a vanished directory from raising an unhandled `'error'` on the watcher.
 */
export const nodeWatchFactory: WatchFactory = (directory, onChange) => {
  const watcher = watch(directory, { persistent: false }, () => onChange())
  watcher.on("error", () => undefined)

  return {
    close: () => {
      try {
        watcher.close()
      } catch {
        // Already closed; disposal is idempotent by contract.
      }
    },
  }
}

export interface Debouncer {
  signal(): void
  clear(): void
  readonly armed: boolean
}

export interface CreateDebouncerInput {
  readonly delayMs: number
  readonly fire: () => void
}

/**
 * One coalescing timer (PD3): the first event arms it, later events are dropped, so a
 * burst yields exactly one refresh and latency is bounded by `delayMs` rather than
 * reset by each event.
 */
export function createDebouncer({ delayMs, fire }: CreateDebouncerInput): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined
  let armed = false

  const settle = (): void => {
    timer = undefined
    armed = false
  }

  return {
    signal() {
      if (armed) return
      armed = true
      timer = setTimeout(() => {
        settle()
        try {
          fire()
        } catch {
          // A failed refresh is reported by the registry; it must not become an unhandled rejection.
        }
      }, delayMs)
    },
    clear() {
      if (timer !== undefined) clearTimeout(timer)
      settle()
    },
    get armed() {
      return armed
    },
  }
}

export interface WatchSet {
  sync(targets: readonly string[]): void
  active(): readonly string[]
  dispose(): void
}

export interface CreateWatchSetInput {
  readonly factory: WatchFactory
  readonly onEvent: () => void
  readonly onDiagnostic: (message: string) => void
}

/** Owns the live handles: opens what the scan derived, closes what it no longer covers. */
export function createWatchSet({ factory, onEvent, onDiagnostic }: CreateWatchSetInput): WatchSet {
  const handles = new Map<string, WatchHandle>()
  let disposed = false

  const open = (directory: string): void => {
    try {
      handles.set(
        directory,
        factory(directory, () => {
          try {
            onEvent()
          } catch {
            // A throwing handler must not escape into the fs.watch callback.
          }
        }),
      )
    } catch (error) {
      onDiagnostic(`watch: ${directory}: ${errorCode(error)}`)
    }
  }

  const close = (directory: string, handle: WatchHandle): void => {
    handles.delete(directory)
    try {
      handle.close()
    } catch (error) {
      onDiagnostic(`watch: ${directory}: ${errorCode(error)}`)
    }
  }

  return {
    sync(targets) {
      if (disposed) return
      const wanted = new Set(targets)

      for (const [directory, handle] of [...handles]) {
        if (!wanted.has(directory)) close(directory, handle)
      }
      for (const directory of wanted) {
        if (!handles.has(directory)) open(directory)
      }
    },
    active() {
      return [...handles.keys()].sort(compareText)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const [directory, handle] of [...handles]) close(directory, handle)
      handles.clear()
    },
  }
}

/** Kind → the two directory segments that make a directory a skill root (mirrors `src/scan.ts`). */
export const WATCH_ROOT_SEGMENTS: Record<SkillRootKind, readonly [string, string]> = {
  "opencode-skills": [".opencode", "skills"],
  "opencode-skill": [".opencode", "skill"],
  "claude-skills": [".claude", "skills"],
  "agents-skills": [".agents", "skills"],
}

export interface DeriveWatchTargetsInput {
  readonly location: string
  readonly candidates: readonly ScanCandidate[]
  readonly prune?: readonly string[]
}

export interface DeriveWatchTargetsResult {
  readonly targets: readonly string[]
  readonly diagnostics: readonly string[]
}

const displayPath = (root: string, target: string): string => {
  const rel = target.slice(root.length).replace(/^[/\\]+/, "")
  return rel === "" ? "." : rel.split(sep).join("/")
}

const canonical = async (target: string): Promise<string> => {
  try {
    return await realpath(target)
  } catch {
    return resolve(target)
  }
}

/**
 * Resolves a candidate's skill root by its last `<leading>/<leaf>` pair, so a nested
 * subproject such as `A/A.1` resolves `A/A.1/.claude/skills` rather than a shallower
 * lookalike. Returns `undefined` when the candidate path carries no such pair.
 */
function skillRootOf(root: string, candidatePath: string, kind: SkillRootKind): string | undefined {
  const segments = candidatePath
    .slice(root.length)
    .split(sep)
    .filter((segment) => segment !== "")
  const [leading, leaf] = WATCH_ROOT_SEGMENTS[kind]

  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] !== leading) continue
    if (segments[index + 1] !== leaf) continue
    return [root, ...segments.slice(0, index + 2)].join(sep)
  }
  return undefined
}

/** `undefined` when the path is inside the location, otherwise the reason it was dropped. */
async function inspect(
  root: string,
  target: string,
  prune: ReadonlySet<string>,
): Promise<{ readonly target: string } | { readonly rejected: string }> {
  const rel = displayPath(root, target)

  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return { rejected: `watch-outside: ${rel}` }
  }
  if (target !== root) {
    const pruned = target.slice(root.length).split(sep).find((segment) => prune.has(segment))
    if (pruned !== undefined) return { rejected: `watch-pruned: ${rel}` }
  }

  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) return { rejected: `watch-symlink: ${rel}` }
    if (!info.isDirectory()) return { rejected: `watch-not-directory: ${rel}` }
  } catch (error) {
    return { rejected: `watch-unavailable: ${rel}: ${errorCode(error)}` }
  }

  return { target: await canonical(target) }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "UNKNOWN"
}

/**
 * Builds the exact directory list to watch from one `ScanResult`. Never throws: every
 * rejected candidate becomes a diagnostic, and the location root is always kept.
 */
export async function deriveWatchTargets({
  location,
  candidates,
  prune,
}: DeriveWatchTargetsInput): Promise<DeriveWatchTargetsResult> {
  const diagnostics: string[] = []
  const pruned = new Set(prune ?? PRUNE_DIRECTORIES)
  const root = await canonical(location)
  const wanted = new Set<string>([root])

  for (const candidate of candidates) {
    const candidatePath = resolve(root, candidate.path)
    wanted.add(resolve(root, candidate.subproject === "" ? "." : candidate.subproject))

    const skillRoot = skillRootOf(root, candidatePath, candidate.root)
    if (skillRoot === undefined) {
      diagnostics.push(`watch-root-unresolved: ${displayPath(root, candidatePath)}`)
    } else {
      wanted.add(skillRoot)
    }
    wanted.add(dirname(candidatePath))
  }

  const kept = new Set<string>()
  for (const target of wanted) {
    const inspected = await inspect(root, target, pruned)
    if ("rejected" in inspected) {
      diagnostics.push(inspected.rejected)
      continue
    }
    kept.add(inspected.target)
  }

  return {
    targets: [...kept].sort(compareText),
    diagnostics: [...new Set(diagnostics)],
  }
}
