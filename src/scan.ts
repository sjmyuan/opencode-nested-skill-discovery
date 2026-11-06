import type { Dirent } from "node:fs"
import { readdir, realpath, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  DEFAULT_SCAN_LIMITS,
  PRUNE_DIRECTORIES,
  SKILL_ROOT_DIRECTORIES,
  SUBPROJECT_MARKERS,
} from "./contracts.ts"
import type {
  ScanCandidate,
  ScanLimits,
  ScanResult,
  SkillRootKind,
  SubprojectMarker,
} from "./contracts.ts"

export interface ScanOptions {
  readonly location: string
  readonly limits?: ScanLimits
  readonly prune?: readonly string[]
  readonly markers?: readonly SubprojectMarker[]
  readonly skillRoots?: readonly SkillRootKind[]
  readonly excludeRoots?: readonly string[]
}

/** Kind → the two directory segments that make a directory a skill root (PD1). */
const SKILL_ROOT_SEGMENTS: Record<SkillRootKind, readonly [string, string]> = {
  "opencode-skills": [".opencode", "skills"],
  "opencode-skill": [".opencode", "skill"],
  "claude-skills": [".claude", "skills"],
  "agents-skills": [".agents", "skills"],
}

const DIAGNOSTIC_LIMIT = 200

interface State {
  readonly candidates: ScanCandidate[]
  readonly diagnostics: string[]
  directories: number
  files: number
  bytes: number
  truncated: boolean
  diagnosticsTruncated: boolean
}

interface Ownership {
  readonly rel: string
  readonly markers: readonly SubprojectMarker[]
}

interface Context {
  readonly limits: ScanLimits
  readonly prune: ReadonlySet<string>
  readonly markers: ReadonlySet<SubprojectMarker>
  readonly roots: readonly SkillRootKind[]
  readonly state: State
  readonly emit: (message: string) => void
}

export async function scanSkills(options: ScanOptions): Promise<ScanResult> {
  const started = performance.now()
  const limits = options.limits ?? DEFAULT_SCAN_LIMITS
  const state: State = {
    candidates: [],
    diagnostics: [],
    directories: 0,
    files: 0,
    bytes: 0,
    truncated: false,
    diagnosticsTruncated: false,
  }

  const emit = (message: string): void => {
    if (state.diagnostics.length < DIAGNOSTIC_LIMIT) {
      state.diagnostics.push(message)
      return
    }
    if (!state.diagnosticsTruncated) {
      state.diagnosticsTruncated = true
      state.diagnostics.push("diagnostics-truncated: further diagnostics omitted")
    }
  }

  const context: Context = {
    limits,
    prune: new Set(options.prune ?? PRUNE_DIRECTORIES),
    markers: new Set(options.markers ?? SUBPROJECT_MARKERS),
    roots: options.skillRoots ?? SKILL_ROOT_DIRECTORIES,
    state,
    emit,
  }

  const finish = (): ScanResult => ({
    candidates: [...state.candidates].sort(compareCandidates),
    stats: {
      directories: state.directories,
      files: state.files,
      bytes: state.bytes,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    },
    truncated: state.truncated,
    diagnostics: [...state.diagnostics],
  })

  let location: string
  try {
    location = await realpath(resolve(options.location))
    const info = await stat(location)
    if (!info.isDirectory()) throw new Error("not a directory")
  } catch (error) {
    emit(`location-unreadable: ${describe(error)}`)
    return finish()
  }

  await walk(context, location, "", null)

  return finish()
}

async function walk(context: Context, dir: string, rel: string, parent: Ownership | null): Promise<void> {
  const entries = await openDirectory(context, dir, rel)
  if (entries === null) return
  const owner = (await probeMarkers(context, dir, rel)) ?? parent

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(dir, entry.name)
    const childRel = joinRel(rel, entry.name)
    if (await openRoots(context, entry.name, child, childRel, owner)) continue
    await walk(context, child, childRel, owner)
  }
}

/** Opens every configured skill root whose leading segment is `name` (PD3). */
async function openRoots(
  context: Context,
  name: string,
  dir: string,
  rel: string,
  owner: Ownership | null,
): Promise<boolean> {
  let opened = false
  for (const kind of context.roots) {
    const [leading, leaf] = SKILL_ROOT_SEGMENTS[kind]
    if (leading !== name) continue
    const root = join(dir, leaf)
    if (!(await isDirectory(root))) continue
    opened = true
    await walkRoot(context, root, joinRel(rel, leaf), kind, true, owner)
  }
  return opened
}

async function walkRoot(
  context: Context,
  dir: string,
  rel: string,
  kind: SkillRootKind,
  atRoot: boolean,
  parent: Ownership | null,
): Promise<void> {
  const entries = await openDirectory(context, dir, rel)
  if (entries === null) return
  // Markers nest inside an open root too: only the walk is unbounded, not the marker probe (PD3).
  const owner = (await probeMarkers(context, dir, rel)) ?? parent

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkRoot(context, join(dir, entry.name), joinRel(rel, entry.name), kind, false, owner)
      continue
    }
    if (!entry.isFile()) continue
    const eligible = atRoot ? entry.name.endsWith(".md") : entry.name === "SKILL.md"
    if (!eligible) continue
    await accept(context, join(dir, entry.name), kind, owner)
  }
}

async function accept(
  context: Context,
  path: string,
  kind: SkillRootKind,
  owner: Ownership | null,
): Promise<void> {
  context.state.files += 1
  context.state.candidates.push({
    path,
    realPath: (await canonical(path)) ?? path,
    subproject: owner?.rel ?? "",
    root: kind,
    markers: owner === null ? [] : [...owner.markers],
  })
}

/** The marker kinds observed on `dir`, in SUBPROJECT_MARKERS order; null when none (PD8). */
async function probeMarkers(context: Context, dir: string, rel: string): Promise<Ownership | null> {
  const found: SubprojectMarker[] = []
  for (const kind of SUBPROJECT_MARKERS) {
    if (!context.markers.has(kind)) continue
    if (await hasMarker(dir, kind)) found.push(kind)
  }
  return found.length === 0 ? null : { rel, markers: found }
}

async function hasMarker(dir: string, kind: SubprojectMarker): Promise<boolean> {
  switch (kind) {
    case "agents-md":
      return isFile(join(dir, "AGENTS.md"))
    case "claude-md":
      return isFile(join(dir, "CLAUDE.md"))
    case "git":
      return exists(join(dir, ".git"))
    case "hg":
      return isDirectory(join(dir, ".hg"))
    default: {
      const [leading, leaf] = SKILL_ROOT_SEGMENTS[kind]
      return isDirectory(join(dir, leading, leaf))
    }
  }
}

async function openDirectory(
  context: Context,
  dir: string,
  rel: string,
): Promise<Dirent<string>[] | null> {
  if (context.state.directories >= context.limits.maxDirectories) {
    context.state.truncated = true
    context.emit(`budget-directories: maxDirectories=${context.limits.maxDirectories}`)
    return null
  }
  context.state.directories += 1
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    return entries
  } catch (error) {
    context.emit(`unreadable-directory: ${rel === "" ? "." : rel} (${describe(error)})`)
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function joinRel(rel: string, name: string): string {
  return rel === "" ? name : `${rel}/${name}`
}

function compareCandidates(left: ScanCandidate, right: ScanCandidate): number {
  if (left.realPath !== right.realPath) return left.realPath < right.realPath ? -1 : 1
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  return 0
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
