import type { Dirent } from "node:fs"
import { readdir, realpath, stat } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { DEFAULT_SCAN_LIMITS } from "./contracts.ts"
import type { ScanLimits } from "./contracts.ts"
import type { NativeRootInput } from "./native.ts"
import { deriveCommandName } from "./scan.ts"

/**
 * Native command names visible from one location (ADR command R4, R5; plan PD2–PD5).
 *
 * Native discovery walks upward only, so the visible set is the location's ancestors
 * — the location included — plus the readable global config directory. Names come from
 * `.opencode/{command,commands}/**\/*.md` paths alone, exactly as native `decode()` does,
 * so no content is read and a file native would reject at decode still removes its name.
 * A stat-only walk shares the scan directory and file budgets; a symlinked `.opencode` is
 * followed, a nested directory symlink is not, and a file symlink is named by its link path.
 */
export interface NativeCommandNameIndex {
  readonly names: readonly string[]
  readonly complete: boolean
  readonly diagnostics: readonly string[]
}

const CONFIG_DIRECTORY = ".opencode"
const COMMAND_DIRECTORIES = ["command", "commands"] as const

type StatKind = "missing" | "unreadable" | "file" | "directory"

interface Counts {
  directories: number
  files: number
  stopped: boolean
}

export async function resolveNativeCommandNames(
  input: NativeRootInput,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): Promise<NativeCommandNameIndex> {
  const names = new Set<string>()
  const diagnostics: string[] = []
  const counts: Counts = { directories: 0, files: 0, stopped: false }

  const report = (line: string): void => {
    if (!diagnostics.includes(line)) diagnostics.push(line)
  }

  const admit = (name: string): void => {
    if (counts.files >= limits.maxFiles) {
      counts.stopped = true
      report(`budget-files: maxFiles=${limits.maxFiles}`)
      return
    }
    counts.files += 1
    names.add(name)
  }

  const walk = async (dir: string, rootDir: string, label: string): Promise<void> => {
    if (counts.stopped) return
    if (counts.directories >= limits.maxDirectories) {
      counts.stopped = true
      report(`budget-directories: maxDirectories=${limits.maxDirectories}`)
      return
    }
    counts.directories += 1

    let entries: Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      report(`native-root-unreadable: ${label}`)
      return
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    for (const entry of entries) {
      if (counts.stopped) return
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        if (!entry.name.endsWith(".md")) continue
        if ((await statKind(path)) === "file") admit(deriveCommandName(rootDir, path))
        continue
      }
      if (entry.isDirectory()) {
        await walk(path, rootDir, label)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith(".md")) continue
      admit(deriveCommandName(rootDir, path))
    }
  }

  const scanRoot = async (rootDir: string, label: string): Promise<void> => {
    const kind = await statKind(rootDir)
    if (kind === "unreadable") {
      report(`native-root-unreadable: ${label}`)
      return
    }
    if (kind !== "directory") return
    await walk(rootDir, rootDir, label)
  }

  const location = (await canonical(resolve(input.location))) ?? resolve(input.location)
  for (const ancestor of ancestorsOf(location)) {
    const config = join(ancestor, CONFIG_DIRECTORY)
    const kind = await statKind(config)
    if (kind === "unreadable") {
      report(`native-root-unreadable: ${labelFor(location, config)}`)
      continue
    }
    if (kind !== "directory") continue
    for (const leaf of COMMAND_DIRECTORIES) {
      const root = join(config, leaf)
      await scanRoot(root, labelFor(location, root))
    }
  }

  const global = input.configDirectory
  if (global !== "") {
    const kind = await statKind(global)
    if (kind === "unreadable") {
      report("native-root-unreadable: global")
    } else if (kind === "directory") {
      for (const leaf of COMMAND_DIRECTORIES) await scanRoot(join(global, leaf), "global")
    }
  }

  return {
    names: [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    complete: diagnostics.length === 0,
    diagnostics,
  }
}

function ancestorsOf(location: string): readonly string[] {
  const ancestors: string[] = []
  let current = resolve(location)
  for (;;) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) return ancestors
    current = parent
  }
}

/** Diagnostics carry a location-relative label, never an absolute path (plan PD8). */
function labelFor(location: string, path: string): string {
  return relative(location, path).split(sep).join("/")
}

async function statKind(path: string): Promise<StatKind> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "file"
  } catch (error) {
    return isMissing(error) ? "missing" : "unreadable"
  }
}

function isMissing(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}
