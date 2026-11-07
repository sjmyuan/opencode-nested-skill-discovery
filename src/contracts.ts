export interface SkillEntry {
  readonly id: string
  readonly canonicalPath: string
  readonly name: string
  readonly description?: string
  readonly autoinvoke?: boolean
}

export interface RegistryEntry extends SkillEntry {
  readonly content: string
}

export interface Snapshot {
  readonly scopeToken: string
  readonly directory: string
  readonly skills: readonly RegistryEntry[]
}

export interface RegistrySnapshot {
  readonly location: string
  readonly snapshots: readonly Snapshot[]
}

export interface ManifestRecord {
  readonly manifestVersion: number
  readonly scopeToken: string
  readonly directory: string
  readonly entries: readonly SkillEntry[]
}

export type SkillRootKind = "opencode-skills" | "opencode-skill" | "claude-skills" | "agents-skills"

export type CommandRootKind = "opencode-command" | "opencode-commands"

export type SubprojectMarker =
  | SkillRootKind
  | CommandRootKind
  | "agents-md"
  | "claude-md"
  | "git"
  | "hg"

export interface ScanCandidate {
  readonly path: string
  readonly realPath: string
  readonly subproject: string
  readonly root: SkillRootKind
  readonly markers: readonly SubprojectMarker[]
}

/**
 * A command file found by the shared walk (ADR command R1, R5–R7, R17).
 *
 * Identity only: frontmatter is not read in F1, so `description`, `agent`,
 * `model`, and `subagent` arrive at the index stage (PD4).
 */
export interface CommandCandidate {
  readonly name: string
  readonly path: string
  readonly canonicalPath: string
  readonly subproject: string
  readonly subprojectRealPath: string
  readonly root: CommandRootKind
  readonly markers: readonly SubprojectMarker[]
}

/**
 * The published command, split into what the snapshot records and what it replays
 * (ADR command R16; plan PD1). The composed name is the identity.
 */
export interface CommandManifestEntry {
  readonly name: string
  readonly canonicalPath: string
  readonly description?: string
  readonly agent?: string
  readonly model?: string
  readonly subagent?: boolean
}

export interface CommandEntry extends CommandManifestEntry {
  readonly template: string
}

export interface CommandSnapshot {
  readonly scopeToken: string
  readonly directory: string
  readonly commands: readonly CommandEntry[]
}

export interface CommandSnapshotSet {
  readonly location: string
  readonly snapshots: readonly CommandSnapshot[]
}

export interface ScanStats {
  readonly directories: number
  readonly files: number
  readonly bytes: number
  readonly elapsedMs: number
}

export interface ScanResult {
  readonly candidates: readonly ScanCandidate[]
  readonly commands: readonly CommandCandidate[]
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

export const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export const ID_PREFIX = "nested."
export const MAX_ID_LENGTH = 96
export const MAX_SCOPE_SLUG_LENGTH = 24
export const MAX_SKILL_SLUG_LENGTH = 40
export const MAX_NAME_LENGTH = 80
export const MAX_DESCRIPTION_LENGTH = 500
export const DEBOUNCE_MS = 250
// Bounds the prompt backstop to one refresh per window; the measured full scan is ≈0.17 s,
// so the worst case is ≤8.5 % of one core and a recent watcher refresh suppresses it entirely.
export const PROMPT_THROTTLE_MS = 2_000

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

export const COMMAND_ROOT_DIRECTORIES: readonly CommandRootKind[] = [
  "opencode-command",
  "opencode-commands",
]

// Symbolic kinds, not file names; F2 owns the kind → R6 name map:
// .opencode/skills, .opencode/skill, .claude/skills, .agents/skills,
// .opencode/command, .opencode/commands,
// AGENTS.md, CLAUDE.md, .git (directory or file), .hg
export const SUBPROJECT_MARKERS: readonly SubprojectMarker[] = [
  ...SKILL_ROOT_DIRECTORIES,
  ...COMMAND_ROOT_DIRECTORIES,
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
