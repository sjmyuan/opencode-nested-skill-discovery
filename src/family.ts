import { lstat, open, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const GIT_FILE_LIMIT = 4096
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/

export interface RepoFamily {
  readonly familyKey: string
  readonly survivor: string
}

export interface FamilyContext extends RepoFamily {
  readonly checkout: string
}

export interface FamilyResolution {
  readonly family?: RepoFamily
  readonly diagnostic?: string
}

export interface DeriveFamiliesResult {
  readonly location: string
  readonly families: ReadonlyMap<string, FamilyContext>
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

async function familyOfGitdir(root: string, gitdir: string): Promise<FamilyResolution> {
  if (basename(dirname(gitdir)) !== "worktrees") {
    return { family: { familyKey: gitdir, survivor: root } }
  }

  const commonDir = dirname(dirname(gitdir))
  if (!(await isOwnedCommonDir(commonDir))) {
    return { diagnostic: `family: ${root}: common dir not a parent .git` }
  }

  return { family: { familyKey: commonDir, survivor: dirname(commonDir) } }
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
  try {
    return await familyOfGitdir(root, await realpath(target))
  } catch (error) {
    return { diagnostic: `family: ${root}: gitdir target unresolvable: ${reasonOf(error)}` }
  }
}

export interface CheckoutMemo {
  readonly checkouts: Map<string, string | null>
  readonly families: Map<string, FamilyResolution>
}

export interface CheckoutResolution {
  readonly checkout?: string
  readonly family?: RepoFamily
  readonly diagnostic?: string
}

export const createCheckoutMemo = (): CheckoutMemo => ({ checkouts: new Map(), families: new Map() })

async function familyAt(checkout: string, memo: CheckoutMemo): Promise<FamilyResolution> {
  const known = memo.families.get(checkout)
  if (known !== undefined) return known

  const resolution = await resolveRepoFamily(checkout)
  memo.families.set(checkout, resolution)
  return resolution
}

async function enclosingCheckout(
  directory: string,
  location: string,
  memo: CheckoutMemo,
): Promise<string | null> {
  const visited: string[] = []
  let current = dirname(directory)

  for (;;) {
    const known = memo.checkouts.get(current)
    if (known !== undefined) {
      for (const ancestor of visited) memo.checkouts.set(ancestor, known)
      return known
    }
    if (!isStrictDescendant(current, location)) {
      for (const ancestor of visited) memo.checkouts.set(ancestor, null)
      return null
    }
    visited.push(current)

    try {
      await lstat(join(current, ".git"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        current = dirname(current)
        continue
      }
    }

    for (const ancestor of visited) memo.checkouts.set(ancestor, current)
    return current
  }
}

export async function resolveCheckout(
  directory: string,
  location: string,
  memo: CheckoutMemo = createCheckoutMemo(),
): Promise<CheckoutResolution> {
  const own = await familyAt(directory, memo)
  if (own.family !== undefined) return { checkout: directory, family: own.family }
  if (own.diagnostic !== undefined) return { diagnostic: own.diagnostic }

  const enclosing = await enclosingCheckout(directory, location, memo)
  if (enclosing === null) return {}

  const family = await familyAt(enclosing, memo)
  if (family.diagnostic !== undefined) return { diagnostic: family.diagnostic }
  if (family.family === undefined) return {}

  return { checkout: enclosing, family: family.family }
}

/**
 * One family derivation pass (ADR command R8, discovery R20): a single
 * checkout memo and a single diagnostic-seen set, so the skill stage and any
 * later stage in the same refresh share one ancestor walk and one report.
 */
export interface FamilyPass {
  readonly location: string
  derive(checkouts: readonly string[]): Promise<DeriveFamiliesResult>
}

export async function createFamilyPass(location: string): Promise<FamilyPass> {
  const canonicalLocation = await canonical(location)
  const memo = createCheckoutMemo()
  const seen = new Set<string>()

  return {
    location: canonicalLocation,
    async derive(checkouts: readonly string[]): Promise<DeriveFamiliesResult> {
      const distinct = [...new Set(checkouts)].sort(compareText)
      const families = new Map<string, FamilyContext>()
      const diagnostics: string[] = []

      for (const subproject of distinct) {
        const resolution = await resolveCheckout(subproject, canonicalLocation, memo)
        if (resolution.diagnostic !== undefined && !seen.has(resolution.diagnostic)) {
          seen.add(resolution.diagnostic)
          diagnostics.push(resolution.diagnostic)
        }
        if (resolution.checkout !== undefined && resolution.family !== undefined) {
          families.set(subproject, { ...resolution.family, checkout: resolution.checkout })
        }
      }

      return { location: canonicalLocation, families, diagnostics }
    },
  }
}

export async function deriveFamilies(
  checkouts: readonly string[],
  location: string,
): Promise<DeriveFamiliesResult> {
  return (await createFamilyPass(location)).derive(checkouts)
}

const isStrictDescendant = (target: string, root: string): boolean => {
  const relativePath = relative(root, target)
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

const toPosix = (value: string): string => value.split(sep).join("/")

const pairingKey = (family: FamilyContext, realPath: string): string =>
  `${family.familyKey}\u0000${toPosix(relative(family.checkout, realPath))}`

const survivorPathKeys = (
  entries: readonly FamilyEntry[],
  families: ReadonlyMap<string, FamilyContext>,
): ReadonlySet<string> => {
  const keys = new Set<string>()
  for (const entry of entries) {
    const family = families.get(entry.subprojectRealPath)
    if (family === undefined || family.checkout !== family.survivor) continue
    keys.add(pairingKey(family, entry.candidate.realPath))
  }
  return keys
}

export function selectSurvivorEntries<T extends FamilyEntry>(
  entries: readonly T[],
  families: ReadonlyMap<string, FamilyContext>,
  location: string,
): { readonly kept: readonly T[]; readonly diagnostics: readonly string[] } {
  const survivorPaths = survivorPathKeys(entries, families)
  const kept: T[] = []
  const diagnostics: string[] = []

  for (const entry of entries) {
    const family = families.get(entry.subprojectRealPath)
    if (family === undefined || family.checkout === family.survivor) {
      kept.push(entry)
      continue
    }
    if (!isStrictDescendant(family.checkout, location) || !isStrictDescendant(family.survivor, location)) {
      kept.push(entry)
      continue
    }

    const path = toPosix(relative(family.checkout, entry.candidate.realPath))
    const note = survivorPaths.has(`${family.familyKey}\u0000${path}`)
      ? `(survivor ${family.survivor} has it)`
      : `(missing at survivor ${family.survivor})`
    diagnostics.push(`family: suppressed ${path} from ${family.checkout} ${note}`)
  }

  return { kept, diagnostics }
}
