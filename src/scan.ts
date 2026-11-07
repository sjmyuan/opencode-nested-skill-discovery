import type { Dirent } from "node:fs"
import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import {
  DEFAULT_SCAN_LIMITS,
  PRUNE_DIRECTORIES,
  SKILL_ROOT_DIRECTORIES,
  SUBPROJECT_MARKERS,
} from "./contracts.ts"
import type {
  CommandRootKind,
  ScanCandidate,
  ScanLimits,
  ScanResult,
  SkillRootKind,
  SubprojectMarker,
} from "./contracts.ts"

/**
 * F2 bounded scan (ADR R6–R9, R17; plan PD1–PD11).
 *
 * Walks one location as a sorted pre-order DFS: markers nest and never stop the
 * walk, depth is capped at the subproject boundary, an opened skill root is
 * descended without a depth cap, and directory/file/byte budgets plus the
 * diagnostic cap bound the result. It stats only — no content is ever read — and
 * it never throws for a filesystem error.
 */
export interface ScanOptions {
  readonly location: string
  readonly limits?: ScanLimits
  readonly prune?: readonly string[]
  readonly markers?: readonly SubprojectMarker[]
  readonly skillRoots?: readonly SkillRootKind[]
  readonly excludeRoots?: readonly string[]
}

/** Kind → the two directory segments that make a directory a root (PD1). */
const ROOT_SEGMENTS: Record<SkillRootKind | CommandRootKind, readonly [string, string]> = {
  "opencode-skills": [".opencode", "skills"],
  "opencode-skill": [".opencode", "skill"],
  "claude-skills": [".claude", "skills"],
  "agents-skills": [".agents", "skills"],
  "opencode-command": [".opencode", "command"],
  "opencode-commands": [".opencode", "commands"],
}

const DIAGNOSTIC_LIMIT = 200

interface State {
  readonly candidates: ScanCandidate[]
  readonly diagnostics: string[]
  directories: number
  files: number
  accepted: number
  bytes: number
  truncated: boolean
  stopped: boolean
  diagnosticsTruncated: boolean
}

interface Ownership {
  readonly rel: string
  readonly markers: readonly SubprojectMarker[]
}

interface Context {
  readonly location: string
  readonly limits: ScanLimits
  readonly prune: ReadonlySet<string>
  readonly markers: ReadonlySet<SubprojectMarker>
  readonly roots: readonly SkillRootKind[]
  readonly excluded: readonly string[]
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
    accepted: 0,
    bytes: 0,
    truncated: false,
    stopped: false,
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

  const finish = (): ScanResult => ({
    candidates: [...state.candidates].sort(compareCandidates),
    commands: [],
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
    emit(`location-unreadable: ${errorCode(error)}`)
    return finish()
  }

  const context: Context = {
    location,
    limits,
    prune: new Set(options.prune ?? PRUNE_DIRECTORIES),
    markers: new Set(options.markers ?? SUBPROJECT_MARKERS),
    roots: options.skillRoots ?? SKILL_ROOT_DIRECTORIES,
    excluded: await canonicalRoots(options.excludeRoots ?? []),
    state,
    emit,
  }

  await walk(context, location, "", null, 0)

  return finish()
}

async function walk(
  context: Context,
  dir: string,
  rel: string,
  parent: Ownership | null,
  depth: number,
): Promise<void> {
  const entries = await openDirectory(context, dir, rel)
  if (entries === null) return
  const owner = (await probeMarkers(context, dir, rel)) ?? parent

  // PD3: the cap measures subproject distance from the location, not skill-file depth.
  const childDepth = depth + 1
  for (const entry of entries) {
    if (context.state.stopped) return
    // Pruning precedes every classification, so a pruned link is as silent as a pruned directory (F-5).
    if (context.prune.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      await inspectLink(context, join(dir, entry.name), joinRel(rel, entry.name))
      continue
    }
    if (!entry.isDirectory()) continue
    const child = join(dir, entry.name)
    if (isExcluded(context, child)) continue
    const childRel = joinRel(rel, entry.name)
    // A root of a visited directory is opened without a depth check; only ordinary descent is capped.
    if (await openRoots(context, entry.name, child, childRel, owner)) continue
    if (childDepth > context.limits.maxDepth) continue
    await walk(context, child, childRel, owner, childDepth)
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
    const [leading, leaf] = ROOT_SEGMENTS[kind]
    if (leading !== name) continue
    const root = join(dir, leaf)
    const rootRel = joinRel(rel, leaf)
    const probe = await probeRoot(context, root, rootRel)
    if (probe === "missing") continue
    // Claimed either way: a refused root must not also be re-walked as an ordinary directory.
    opened = true
    if (probe === "refused") continue
    if (isExcluded(context, root)) continue
    await walkRoot(context, root, rootRel, kind, true, owner)
  }
  return opened
}

/** A skill root must be a real directory inside the location; a symlinked or escaping root is refused (D2). */
async function probeRoot(context: Context, root: string, rel: string): Promise<"missing" | "refused" | "ready"> {
  let info
  try {
    info = await lstat(root)
  } catch {
    return "missing"
  }
  if (info.isSymbolicLink()) {
    context.emit(`directory-symlink: ${rel}`)
    return "refused"
  }
  if (!info.isDirectory()) return "missing"
  const real = await canonical(root)
  if (real === null || !isInside(context.location, real)) {
    context.emit(`root-refused: ${rel}`)
    return "refused"
  }
  return "ready"
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
    if (context.state.stopped) return
    if (entry.isSymbolicLink()) {
      await acceptLink(context, join(dir, entry.name), joinRel(rel, entry.name), kind, atRoot, owner)
      continue
    }
    if (entry.isDirectory()) {
      if (context.prune.has(entry.name)) continue
      const child = join(dir, entry.name)
      if (isExcluded(context, child)) continue
      await walkRoot(context, child, joinRel(rel, entry.name), kind, false, owner)
      continue
    }
    if (!entry.isFile()) continue
    if (!eligible(entry.name, atRoot)) continue
    await accept(context, join(dir, entry.name), kind, owner)
  }
}

// Native glob parity (PD4): dot-md directly under the root, SKILL.md at any level below it.
function eligible(name: string, atRoot: boolean): boolean {
  return atRoot ? name.endsWith(".md") : name === "SKILL.md"
}

type LinkTarget =
  | { readonly type: "directory" }
  | { readonly type: "file"; readonly realPath: string }
  | { readonly type: "broken" }

async function resolveLink(path: string): Promise<LinkTarget> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return { type: "directory" }
    if (!info.isFile()) return { type: "broken" }
    return { type: "file", realPath: await realpath(path) }
  } catch {
    return { type: "broken" }
  }
}

/** Outside an open root no file is a candidate: only the skip is reported. */
async function inspectLink(context: Context, path: string, rel: string): Promise<void> {
  const link = await resolveLink(path)
  if (link.type === "directory") context.emit(`directory-symlink: ${rel}`)
  else if (link.type === "broken") context.emit(`file-symlink-broken: ${rel}`)
}

async function acceptLink(
  context: Context,
  path: string,
  rel: string,
  kind: SkillRootKind,
  atRoot: boolean,
  owner: Ownership | null,
): Promise<void> {
  const link = await resolveLink(path)
  if (link.type === "directory") {
    context.emit(`directory-symlink: ${rel}`)
    return
  }
  // An ineligible link could never be a candidate, so its target or brokenness is not worth a diagnostic (F-5).
  if (!eligible(basename(path), atRoot)) return
  if (link.type === "broken") {
    context.emit(`file-symlink-broken: ${rel}`)
    return
  }
  if (!isInside(context.location, link.realPath)) {
    context.emit(`file-symlink-outside: ${rel}`)
    return
  }
  await accept(context, path, kind, owner, link.realPath)
}

function isExcluded(context: Context, path: string): boolean {
  return context.excluded.some((root) => path === root || path.startsWith(`${root}${sep}`))
}

/** Canonicalised once; entries that cannot be resolved are skipped silently (PD10). */
async function canonicalRoots(roots: readonly string[]): Promise<readonly string[]> {
  const resolved = await Promise.all(roots.map((root) => canonical(resolve(root))))
  return resolved.filter((root): root is string => root !== null)
}

function isInside(location: string, target: string): boolean {
  return target === location || target.startsWith(`${location}${sep}`)
}

async function accept(
  context: Context,
  path: string,
  kind: SkillRootKind,
  owner: Ownership | null,
  realPath?: string,
): Promise<void> {
  if (context.state.accepted >= context.limits.maxFiles) {
    context.state.truncated = true
    context.state.stopped = true
    context.emit(`budget-files: maxFiles=${context.limits.maxFiles}`)
    return
  }

  let info
  try {
    info = await stat(path)
  } catch (error) {
    context.emit(`unreadable-file: ${relativeToLocation(context, path)} (${errorCode(error)})`)
    return
  }
  context.state.files += 1

  const relPath = relativeToLocation(context, path)
  if (info.size > context.limits.maxFileBytes) {
    context.state.truncated = true
    context.emit(
      `budget-file-bytes: ${relPath} size=${info.size} maxFileBytes=${context.limits.maxFileBytes}`,
    )
    return
  }

  if (context.state.bytes + info.size > context.limits.maxTotalBytes) {
    context.state.truncated = true
    context.state.stopped = true
    context.emit(`budget-total-bytes: maxTotalBytes=${context.limits.maxTotalBytes}`)
    return
  }

  context.state.bytes += info.size
  context.state.accepted += 1
  context.state.candidates.push({
    path,
    realPath: realPath ?? (await canonical(path)) ?? path,
    subproject: owner?.rel ?? "",
    root: kind,
    markers: owner === null ? [] : [...owner.markers],
  })
}

function relativeToLocation(context: Context, path: string): string {
  const rel = relative(context.location, path)
  return rel === "" ? "." : rel.split(sep).join("/")
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
      return isRealDirectory(join(dir, ".hg"))
    default: {
      const [leading, leaf] = ROOT_SEGMENTS[kind]
      return isRealDirectory(join(dir, leading, leaf))
    }
  }
}

async function openDirectory(
  context: Context,
  dir: string,
  rel: string,
): Promise<Dirent<string>[] | null> {
  if (context.state.stopped) return null
  if (context.state.directories >= context.limits.maxDirectories) {
    context.state.truncated = true
    context.state.stopped = true
    context.emit(`budget-directories: maxDirectories=${context.limits.maxDirectories}`)
    return null
  }
  context.state.directories += 1
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    return entries
  } catch (error) {
    context.emit(`unreadable-directory: ${rel === "" ? "." : rel} (${errorCode(error)})`)
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

/** lstat, so a symlinked path is never accepted as a real directory (D2). */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
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

/** D3: diagnostics carry `error.code`, never `Error.message` (which embeds absolute paths). */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "UNKNOWN"
}
