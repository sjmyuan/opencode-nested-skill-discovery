export interface SkillEntry {
  readonly id: string
  readonly canonicalPath: string
  readonly name: string
  readonly description?: string
  readonly autoinvoke?: boolean
}

export interface Snapshot {
  readonly scopeToken: string
  readonly directory: string
  readonly skills: readonly SkillEntry[]
}

export interface ManifestRecord {
  readonly manifestVersion: number
  readonly scopeToken: string
  readonly directory: string
  readonly entries: readonly SkillEntry[]
}

export type SkillRootKind = "opencode-skills" | "opencode-skill" | "claude-skills" | "agents-skills"

export type SubprojectMarker = SkillRootKind | "agents-md" | "claude-md" | "git" | "hg"

export interface ScanCandidate {
  readonly path: string
  readonly realPath: string
  readonly subproject: string
  readonly root: SkillRootKind
  readonly markers: readonly SubprojectMarker[]
}

export interface ScanStats {
  readonly directories: number
  readonly files: number
  readonly bytes: number
  readonly elapsedMs: number
}

export interface ScanResult {
  readonly candidates: readonly ScanCandidate[]
  readonly stats: ScanStats
  readonly truncated: boolean
  readonly diagnostics: readonly string[]
}

export interface ScanLimits {
  readonly maxDepth: number
  readonly maxDirectories: number
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export interface PluginConfig {
  readonly limits: ScanLimits
  readonly debounceMs: number
  readonly prune: readonly string[]
  readonly markers: readonly SubprojectMarker[]
  readonly skillRoots: readonly SkillRootKind[]
  readonly maxNameLength: number
  readonly maxDescriptionLength: number
}

export const ID_PREFIX = "nested."
export const MAX_ID_LENGTH = 96
export const MAX_SCOPE_SLUG_LENGTH = 24
export const MAX_SKILL_SLUG_LENGTH = 40
export const MAX_NAME_LENGTH = 80
export const MAX_DESCRIPTION_LENGTH = 500
export const DEBOUNCE_MS = 250

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxDepth: 5,
  maxDirectories: 20_000,
  maxFiles: 5_000,
  maxFileBytes: 131_072,
  maxTotalBytes: 16_777_216,
}

export const PRUNE_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".next",
  ".cache",
  "vendor",
]

export const SKILL_ROOT_DIRECTORIES: readonly SkillRootKind[] = [
  "opencode-skills",
  "opencode-skill",
  "claude-skills",
  "agents-skills",
]

// Symbolic kinds, not file names; F2 owns the kind → R6 name map:
// .opencode/skills, .opencode/skill, .claude/skills, .agents/skills,
// AGENTS.md, CLAUDE.md, .git (directory or file), .hg
export const SUBPROJECT_MARKERS: readonly SubprojectMarker[] = [
  ...SKILL_ROOT_DIRECTORIES,
  "agents-md",
  "claude-md",
  "git",
  "hg",
]

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  limits: DEFAULT_SCAN_LIMITS,
  debounceMs: DEBOUNCE_MS,
  prune: PRUNE_DIRECTORIES,
  markers: SUBPROJECT_MARKERS,
  skillRoots: SKILL_ROOT_DIRECTORIES,
  maxNameLength: MAX_NAME_LENGTH,
  maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
}

export const STORAGE_KEYS = {
  version: "nested/manifest/version",
  manifest: (scopeToken: string): string => `nested/manifest/${scopeToken}`,
  subproject: (scopeToken: string): string => `nested/subproject/${scopeToken}`,
}
