import { readdir, realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"
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

export async function scanSkills(options: ScanOptions): Promise<ScanResult> {
  const started = performance.now()
  const limits = options.limits ?? DEFAULT_SCAN_LIMITS
  const prune = new Set(options.prune ?? PRUNE_DIRECTORIES)
  const markers = options.markers ?? SUBPROJECT_MARKERS
  const roots = options.skillRoots ?? SKILL_ROOT_DIRECTORIES
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

  void prune
  void markers
  void roots

  await visit(location, "")

  async function visit(dir: string, rel: string): Promise<void> {
    if (state.directories >= limits.maxDirectories) {
      state.truncated = true
      emit(`budget-directories: maxDirectories=${limits.maxDirectories}`)
      return
    }
    state.directories += 1
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      emit(`unreadable-directory: ${rel === "" ? "." : rel} (${describe(error)})`)
      return
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      void entry
    }
  }

  return finish()
}

function compareCandidates(left: ScanCandidate, right: ScanCandidate): number {
  if (left.realPath !== right.realPath) return left.realPath < right.realPath ? -1 : 1
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  return 0
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
