import { describe, expect, it } from "vitest"
import {
  DEBOUNCE_MS,
  DEFAULT_PLUGIN_CONFIG,
  DEFAULT_SCAN_LIMITS,
  ID_PREFIX,
  MAX_DESCRIPTION_LENGTH,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SCOPE_SLUG_LENGTH,
  MAX_SKILL_SLUG_LENGTH,
  COMMAND_ROOT_DIRECTORIES,
  PRUNE_DIRECTORIES,
  PROMPT_THROTTLE_MS,
  SKILL_ROOT_DIRECTORIES,
  STORAGE_KEYS,
  SUBPROJECT_MARKERS,
} from "../src/contracts.ts"
import type {
  ManifestRecord,
  RegistryEntry,
  RegistrySnapshot,
  SkillEntry,
  Snapshot,
} from "../src/contracts.ts"

const ADR_PRUNE_DIRECTORIES = [
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".svn",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
]

const ADR_SUBPROJECT_MARKERS = [
  "agents-md",
  "agents-skills",
  "claude-md",
  "claude-skills",
  "git",
  "hg",
  "opencode-command",
  "opencode-commands",
  "opencode-skill",
  "opencode-skills",
]

const ADR_SKILL_ROOT_DIRECTORIES = [
  "agents-skills",
  "claude-skills",
  "opencode-skill",
  "opencode-skills",
]

const ADR_COMMAND_ROOT_DIRECTORIES = ["opencode-command", "opencode-commands"]

describe("scan budgets", () => {
  it("matches the ADR defaults", () => {
    expect(DEFAULT_SCAN_LIMITS).toEqual({
      maxDepth: 5,
      maxDirectories: 100_000,
      maxFiles: 5_000,
      maxFileBytes: 131_072,
      maxTotalBytes: 16_777_216,
    })
  })

  it("debounces for 250 ms", () => {
    expect(DEBOUNCE_MS).toBe(250)
  })

  it("caps name and description length", () => {
    expect(MAX_NAME_LENGTH).toBe(80)
    expect(MAX_DESCRIPTION_LENGTH).toBe(500)
  })

  it("throttles the prompt backstop to one refresh per window", () => {
    expect(PROMPT_THROTTLE_MS).toBe(2000)
    // A backstop slower than the debounce: the watchers stay the fast path, never the fallback.
    expect(PROMPT_THROTTLE_MS).toBeGreaterThan(DEBOUNCE_MS)
  })

  it("composes the default config from the ADR defaults", () => {
    expect(DEFAULT_PLUGIN_CONFIG).toEqual({
      limits: DEFAULT_SCAN_LIMITS,
      debounceMs: DEBOUNCE_MS,
      prune: PRUNE_DIRECTORIES,
      markers: SUBPROJECT_MARKERS,
      skillRoots: SKILL_ROOT_DIRECTORIES,
      maxNameLength: MAX_NAME_LENGTH,
      maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
    })
  })
})

describe("identifier grammar", () => {
  it("prefixes every nested id", () => {
    expect(ID_PREFIX).toBe("nested.")
  })

  it("caps ids and slugs", () => {
    expect(MAX_ID_LENGTH).toBe(96)
    expect(MAX_SCOPE_SLUG_LENGTH).toBe(24)
    expect(MAX_SKILL_SLUG_LENGTH).toBe(40)
  })
})

describe("discovery rules", () => {
  it("prunes exactly the R7 directories", () => {
    expect([...PRUNE_DIRECTORIES].sort()).toEqual(ADR_PRUNE_DIRECTORIES)
  })

  it("enumerates the ten R6 subproject marker kinds", () => {
    expect([...SUBPROJECT_MARKERS].sort()).toEqual(ADR_SUBPROJECT_MARKERS)
  })

  it("scans exactly the four skill root directories", () => {
    expect([...SKILL_ROOT_DIRECTORIES].sort()).toEqual(ADR_SKILL_ROOT_DIRECTORIES)
  })

  it("scans exactly the two command root directories", () => {
    expect([...COMMAND_ROOT_DIRECTORIES].sort()).toEqual(ADR_COMMAND_ROOT_DIRECTORIES)
  })
})

describe("storage keys", () => {
  it("namespaces manifest keys", () => {
    expect(STORAGE_KEYS.version("ws-fce99486")).toBe("nested/ws-fce99486/manifest/version")
    expect(STORAGE_KEYS.manifest("ws-fce99486", "abc123")).toBe("nested/ws-fce99486/manifest/abc123")
  })

  it("namespaces subproject keys", () => {
    expect(STORAGE_KEYS.subproject("ws-fce99486", "abc123")).toBe("nested/ws-fce99486/subproject/abc123")
  })

  it("namespaces command keys", () => {
    expect(STORAGE_KEYS.commandVersion("ws-fce99486")).toBe("nested/ws-fce99486/commands/version")
    expect(STORAGE_KEYS.commandManifest("ws-fce99486", "abc123")).toBe(
      "nested/ws-fce99486/commands/manifest/abc123",
    )
    expect(STORAGE_KEYS.commandSnapshot("ws-fce99486", "abc123")).toBe("nested/ws-fce99486/commands/abc123")
  })
})

describe("manifest record", () => {
  it("types the manifest version as an integer counter", () => {
    const sample: ManifestRecord = {
      manifestVersion: 42,
      scopeToken: "abc123",
      directory: "/Users/ganggang/work",
      entries: [],
    }
    const version: number = sample.manifestVersion

    expect(typeof version).toBe("number")
    expect(JSON.stringify(sample)).toContain('"manifestVersion":42')
    expect(JSON.parse(JSON.stringify(sample)).manifestVersion).toBe(42)
  })
})

const registryEntry: RegistryEntry = {
  id: "nested.scope.skill",
  canonicalPath: "/tmp/root/.opencode/skills/deploy/SKILL.md",
  name: "deploy",
  content: "# Deploy\n\nDeploys releases.\n",
}

describe("registry entries", () => {
  it("requires the body on a registry entry", () => {
    // @ts-expect-error RegistryEntry carries the skill body
    const withoutContent: RegistryEntry = { id: "nested.a.b", canonicalPath: "/tmp/a", name: "a" }

    expect(withoutContent.canonicalPath).toBe("/tmp/a")
  })

  it("assigns a registry entry where a skill entry is expected", () => {
    const widened: SkillEntry = registryEntry

    expect(widened.name).toBe("deploy")
    expect(widened.id).toBe(registryEntry.id)
  })

  it("keeps content out of the manifest entry shape", () => {
    const skill: SkillEntry = { id: registryEntry.id, canonicalPath: registryEntry.canonicalPath, name: "deploy" }
    const record: ManifestRecord = {
      manifestVersion: 7,
      scopeToken: "scope",
      directory: "/tmp/root",
      entries: [skill],
    }
    const contentOf = (entry: SkillEntry): string | undefined =>
      // @ts-expect-error SkillEntry declares no content
      entry.content

    expect(Object.keys(record.entries[0] ?? {}).sort()).toEqual(["canonicalPath", "id", "name"])
    expect(contentOf(skill)).toBeUndefined()
  })

  it("narrows snapshot skills to registry entries", () => {
    const snapshot: Snapshot = {
      scopeToken: "scope",
      directory: "/tmp/root",
      skills: [registryEntry],
    }
    const registry: RegistrySnapshot = { location: "/tmp/root", snapshots: [snapshot] }

    expect(registry.snapshots[0]?.skills[0]?.content).toBe(registryEntry.content)
    expect(Object.isFrozen(registry.snapshots)).toBe(false)
  })
})
