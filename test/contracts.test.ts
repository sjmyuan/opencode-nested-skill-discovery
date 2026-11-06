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
  PRUNE_DIRECTORIES,
  SKILL_ROOT_DIRECTORIES,
  STORAGE_KEYS,
  SUBPROJECT_MARKERS,
} from "../src/contracts.ts"
import type { ManifestRecord } from "../src/contracts.ts"

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
  "opencode-skill",
  "opencode-skills",
]

const ADR_SKILL_ROOT_DIRECTORIES = [
  "agents-skills",
  "claude-skills",
  "opencode-skill",
  "opencode-skills",
]

describe("scan budgets", () => {
  it("matches the ADR defaults", () => {
    expect(DEFAULT_SCAN_LIMITS).toEqual({
      maxDepth: 5,
      maxDirectories: 20_000,
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

  it("enumerates the eight R6 subproject marker kinds", () => {
    expect([...SUBPROJECT_MARKERS].sort()).toEqual(ADR_SUBPROJECT_MARKERS)
  })

  it("scans exactly the four skill root directories", () => {
    expect([...SKILL_ROOT_DIRECTORIES].sort()).toEqual(ADR_SKILL_ROOT_DIRECTORIES)
  })
})

describe("storage keys", () => {
  it("namespaces manifest keys", () => {
    expect(STORAGE_KEYS.version).toBe("nested/manifest/version")
    expect(STORAGE_KEYS.manifest("abc123")).toBe("nested/manifest/abc123")
  })

  it("namespaces subproject keys", () => {
    expect(STORAGE_KEYS.subproject("abc123")).toBe("nested/subproject/abc123")
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
