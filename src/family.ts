import { lstat, open, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const GIT_FILE_LIMIT = 4096
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/

export interface RepoFamily {
  readonly familyKey: string
  readonly survivor: string
}

export interface FamilyResolution {
  readonly family?: RepoFamily
  readonly diagnostic?: string
}

export interface DeriveFamiliesResult {
  readonly location: string
  readonly families: ReadonlyMap<string, RepoFamily>
  readonly diagnostics: readonly string[]
}

export interface FamilyEntry {
  readonly subprojectRealPath: string
  readonly candidate: { readonly realPath: string }
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  return (error as NodeJS.ErrnoException).code ?? error.message
}

async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return resolve(target)
  }
}

export async function isOwnedCommonDir(commonDir: string): Promise<boolean> {
  if (basename(commonDir) !== ".git") return false
  try {
    return (await realpath(join(dirname(commonDir), ".git"))) === commonDir
  } catch {
    return false
  }
}

type GitdirLine = { readonly target: string } | { readonly diagnostic: string }

async function gitdirOf(checkout: string, gitPath: string): Promise<GitdirLine> {
  let handle
  try {
    handle = await open(gitPath, "r")
  } catch (error) {
    return { diagnostic: `family: ${checkout}: unreadable .git: ${reasonOf(error)}` }
  }

  try {
    const buffer = Buffer.alloc(GIT_FILE_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, GIT_FILE_LIMIT, 0)
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n")
    for (const line of lines) {
      const match = GITDIR_LINE.exec(line)
      if (match?.[1] !== undefined) return { target: match[1] }
    }
    return { diagnostic: `family: ${checkout}: no gitdir line` }
  } catch (error) {
    return { diagnostic: `family: ${checkout}: unreadable .git: ${reasonOf(error)}` }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function isDirectoryEntry(target: string, kind: string): Promise<boolean> {
  if (kind === "dir") return true
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

export async function resolveRepoFamily(checkout: string): Promise<FamilyResolution> {
  const root = await canonical(checkout)
  const gitPath = join(root, ".git")

  let info
  try {
    info = await lstat(gitPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    return { diagnostic: `family: ${root}: unreadable .git: ${reasonOf(error)}` }
  }

  const kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : info.isSymbolicLink() ? "link" : "other"
  if (kind === "other") return { diagnostic: `family: ${root}: unreadable .git: ENOTSUP` }
  if (await isDirectoryEntry(gitPath, kind)) {
    return { family: { familyKey: await canonical(gitPath), survivor: root } }
  }

  const line = await gitdirOf(root, gitPath)
  if ("diagnostic" in line) return line

  const target = isAbsolute(line.target) ? line.target : resolve(root, line.target)
  let gitdir: string
  try {
    gitdir = await realpath(target)
  } catch (error) {
    return { diagnostic: `family: ${root}: gitdir target unresolvable: ${reasonOf(error)}` }
  }

  if (basename(dirname(gitdir)) !== "worktrees") {
    return { family: { familyKey: gitdir, survivor: root } }
  }

  const commonDir = dirname(dirname(gitdir))
  if (!(await isOwnedCommonDir(commonDir))) {
    return { diagnostic: `family: ${root}: common dir not a parent .git` }
  }

  return { family: { familyKey: commonDir, survivor: dirname(commonDir) } }
}

export async function deriveFamilies(
  checkouts: readonly string[],
  location: string,
): Promise<DeriveFamiliesResult> {
  const canonicalLocation = await canonical(location)
  const distinct = [...new Set(checkouts)].sort(compareText)
  const families = new Map<string, RepoFamily>()
  const diagnostics: string[] = []

  for (const checkout of distinct) {
    const resolution = await resolveRepoFamily(checkout)
    if (resolution.diagnostic !== undefined) diagnostics.push(resolution.diagnostic)
    if (resolution.family !== undefined) families.set(checkout, resolution.family)
  }

  return { location: canonicalLocation, families, diagnostics }
}

const isStrictDescendant = (target: string, root: string): boolean => {
  const relativePath = relative(root, target)
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

const toPosix = (value: string): string => value.split(sep).join("/")

export function selectSurvivorEntries<T extends FamilyEntry>(
  entries: readonly T[],
  families: ReadonlyMap<string, RepoFamily>,
  location: string,
): { readonly kept: readonly T[]; readonly diagnostics: readonly string[] } {
  const survivorPaths = new Set<string>()
  for (const entry of entries) {
    const family = families.get(entry.subprojectRealPath)
    if (family === undefined || entry.subprojectRealPath !== family.survivor) continue
    const repoRelative = toPosix(relative(entry.subprojectRealPath, entry.candidate.realPath))
    survivorPaths.add(`${family.familyKey}\u0000${repoRelative}`)
  }

  const kept: T[] = []
  const diagnostics: string[] = []

  for (const entry of entries) {
    const family = families.get(entry.subprojectRealPath)
    if (family === undefined || entry.subprojectRealPath === family.survivor) {
      kept.push(entry)
      continue
    }
    if (!isStrictDescendant(entry.subprojectRealPath, location) || !isStrictDescendant(family.survivor, location)) {
      kept.push(entry)
      continue
    }

    const repoRelative = toPosix(relative(entry.subprojectRealPath, entry.candidate.realPath))
    const note = survivorPaths.has(`${family.familyKey}\u0000${repoRelative}`)
      ? `(survivor ${family.survivor} has it)`
      : `(missing at survivor ${family.survivor})`
    diagnostics.push(`family: suppressed ${repoRelative} from ${entry.subprojectRealPath} ${note}`)
  }

  return { kept, diagnostics }
}
