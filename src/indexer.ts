import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import {
  type ScanCandidate,
  type SkillRootKind,
  ID_PREFIX,
  MAX_SCOPE_SLUG_LENGTH,
  MAX_SKILL_SLUG_LENGTH,
} from "./contracts.ts"
import { type Frontmatter, parseSkillFrontmatter } from "./frontmatter.ts"
import { type FamilyPass, createFamilyPass, selectSurvivorEntries } from "./family.ts"

export interface IndexedSkill {
  readonly id: string
  readonly canonicalPath: string
  readonly subproject: string
  readonly nativeName: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly content: string
}

export interface IndexOptions {
  readonly location: string
  readonly nativeRoots?: readonly string[]
  /** One family pass per refresh (ADR command R8); omit to derive privately. */
  readonly family?: FamilyPass
}

const hash8 = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8)

export function slug(input: string, cap: number): string {
  const collapsed = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (collapsed.length === 0) return "x"
  return collapsed.slice(0, cap).replace(/-+$/g, "") || "x"
}

export function nativeIdFor(filePath: string): string {
  const base = path.basename(filePath)
  if (base === "SKILL.md") return path.basename(path.dirname(filePath))
  return base.endsWith(".md") ? base.slice(0, -".md".length) : base
}

export function scopeTokenFor(subprojectRealPath: string): string {
  return `${slug(path.basename(subprojectRealPath), MAX_SCOPE_SLUG_LENGTH)}-${hash8(subprojectRealPath)}`
}

export function skillTokenFor(nativeId: string, skillRealPath: string): string {
  return `${slug(nativeId, MAX_SKILL_SLUG_LENGTH)}-${hash8(skillRealPath)}`
}

const ROOT_MARKERS: Readonly<Record<SkillRootKind, readonly [string, string]>> = {
  "opencode-skills": [".opencode", "skills"],
  "opencode-skill": [".opencode", "skill"],
  "agents-skills": [".agents", "skills"],
  "claude-skills": [".claude", "skills"],
}

interface Rank {
  readonly rootClass: number
  readonly depth: number
  readonly skillsBeforeSkill: number
}

const rankOf = (candidate: ScanCandidate): Rank => {
  const marker = ROOT_MARKERS[candidate.root]
  const segments = candidate.path.split(path.sep)
  let depth = segments.length - 1
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] === marker[0] && segments[index + 1] === marker[1]) {
      depth = index + 2
      break
    }
  }
  return {
    rootClass: candidate.root.startsWith("opencode") ? 0 : candidate.root === "agents-skills" ? 1 : 2,
    depth,
    skillsBeforeSkill: candidate.root === "opencode-skill" ? 1 : 0,
  }
}

const compareRank = (left: Rank, right: Rank): number =>
  left.rootClass - right.rootClass || right.depth - left.depth || left.skillsBeforeSkill - right.skillsBeforeSkill

const comparePath = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareCandidates = (left: ScanCandidate, right: ScanCandidate): number =>
  compareRank(rankOf(left), rankOf(right)) || comparePath(left.path, right.path) || comparePath(left.realPath, right.realPath)

const isInside = (target: string, root: string): boolean => {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const synthesizeDescription = (body: string): string | undefined => {
  for (const line of body.split("\n")) {
    const text = line.trim()
    if (text === "" || text.startsWith("#")) continue
    return text
  }
  return undefined
}

const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  return (error as NodeJS.ErrnoException).code ?? error.message
}

interface Prepared {
  readonly candidate: ScanCandidate
  readonly subprojectRealPath: string
  readonly nativeId: string
  readonly frontmatter: Frontmatter
  readonly body: string
  readonly rank: Rank
}

const resolveSubproject = async (
  subproject: string,
  location: string,
  cache: Map<string, string | null>,
): Promise<string | null> => {
  const cached = cache.get(subproject)
  if (cached !== undefined) return cached
  const target = path.resolve(location, subproject === "" ? "." : subproject)
  let resolved: string | null
  try {
    resolved = await realpath(target)
  } catch {
    resolved = null
  }
  cache.set(subproject, resolved)
  return resolved
}

const dedupe = (
  entries: readonly Prepared[],
  keyOf: (entry: Prepared) => string,
  diagnostics: string[],
): Prepared[] => {
  const winners = new Map<string, Prepared>()
  for (const entry of entries) {
    const key = keyOf(entry)
    const current = winners.get(key)
    if (current === undefined) {
      winners.set(key, entry)
      continue
    }
    const challengerWins = compareRank(entry.rank, current.rank) < 0
    const winner = challengerWins ? entry : current
    const loser = challengerWins ? current : entry
    winners.set(key, winner)
    diagnostics.push(`duplicate: ${loser.candidate.path} (kept ${winner.candidate.realPath})`)
  }
  return [...winners.values()]
}

const dedupeByRealPath = (entries: readonly Prepared[], diagnostics: string[]): Prepared[] =>
  dedupe(entries, (entry) => entry.candidate.realPath, diagnostics)

const dedupeByNativeId = (entries: readonly Prepared[], diagnostics: string[]): Prepared[] =>
  dedupe(entries, (entry) => `${entry.subprojectRealPath}\u0000${entry.nativeId}`, diagnostics)

const applyFamilies = async (
  entries: readonly Prepared[],
  location: string,
  diagnostics: string[],
  family?: FamilyPass,
): Promise<readonly Prepared[]> => {
  if (entries.length === 0) return entries
  const checkouts = [...new Set(entries.map((entry) => entry.subprojectRealPath))]
  const pass = family ?? (await createFamilyPass(location))
  const derived = await pass.derive(checkouts)
  diagnostics.push(...derived.diagnostics)
  const selected = selectSurvivorEntries(entries, derived.families, pass.location)
  diagnostics.push(...selected.diagnostics)
  return selected.kept
}

const toIndexedSkill = (entry: Prepared): IndexedSkill => {
  const nativeName = entry.frontmatter.name ?? slug(entry.nativeId, MAX_SKILL_SLUG_LENGTH)
  const description = entry.frontmatter.description ?? synthesizeDescription(entry.body) ?? `skill ${nativeName}`
  const autoinvoke = entry.frontmatter.autoinvoke ?? (entry.frontmatter.disableModelInvocation === true ? false : undefined)
  return {
    id: `${ID_PREFIX}${scopeTokenFor(entry.subprojectRealPath)}.${skillTokenFor(entry.nativeId, entry.candidate.realPath)}`,
    canonicalPath: entry.candidate.realPath,
    subproject: entry.candidate.subproject,
    nativeName,
    description,
    ...(autoinvoke === undefined ? {} : { autoinvoke }),
    content: entry.body,
  }
}

export async function indexCandidates(
  candidates: readonly ScanCandidate[],
  options: IndexOptions,
): Promise<{ skills: readonly IndexedSkill[]; diagnostics: readonly string[] }> {
  const nativeRoots = options.nativeRoots ?? []
  const sorted = [...candidates].sort(compareCandidates)
  const subprojects = new Map<string, string | null>()
  const diagnostics: string[] = []
  const prepared: Prepared[] = []

  for (const candidate of sorted) {
    if (nativeRoots.some((root) => isInside(candidate.realPath, root) || isInside(candidate.path, root))) continue

    const subprojectRealPath = await resolveSubproject(candidate.subproject, options.location, subprojects)
    if (subprojectRealPath === null) {
      const target = path.resolve(options.location, candidate.subproject === "" ? "." : candidate.subproject)
      diagnostics.push(`unresolvable subproject: ${target}: cannot resolve`)
      continue
    }

    let text: string
    try {
      text = await readFile(candidate.realPath, "utf8")
    } catch (error) {
      diagnostics.push(`unreadable: ${candidate.realPath}: ${reasonOf(error)}`)
      continue
    }

    const parsed = parseSkillFrontmatter(text, candidate.realPath)
    if (!parsed.ok) {
      diagnostics.push(`malformed frontmatter: ${candidate.realPath}: ${parsed.reason}`)
      continue
    }
    diagnostics.push(...parsed.diagnostics)

    prepared.push({
      candidate,
      subprojectRealPath,
      nativeId: nativeIdFor(candidate.path),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      rank: rankOf(candidate),
    })
  }

  // Dedupe after parsing: a malformed winner must not shadow a valid sibling.
  const deduped = dedupeByNativeId(dedupeByRealPath(prepared, diagnostics), diagnostics)
  const kept = await applyFamilies(deduped, options.location, diagnostics, options.family)
  const skills = kept
    .map(toIndexedSkill)
    .sort((left, right) => comparePath(left.id, right.id))

  return { skills, diagnostics: [...diagnostics].sort(comparePath) }
}
