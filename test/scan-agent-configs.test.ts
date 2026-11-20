import { afterEach, describe, expect, it } from "vitest"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { CONFIG_DOCUMENT_ORDER, DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import type { AgentConfigCandidate } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, createOutside, type ScanFixture } from "./support/scan-fixtures.ts"

/**
 * F16 Step 3 (ADR agent A3, A12; contract C2 config branch): a directory that owns itself
 * and is a strict descendant contributes its own four config documents as candidates — and
 * the walk still reads no content, adds no listing, and reports only the symlink refusal.
 */

const cleanups: Array<() => Promise<void>> = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const summary = (candidates: readonly AgentConfigCandidate[]): readonly string[] =>
  candidates.map((candidate) => `${candidate.subproject}:${candidate.document}`)

describe("config document candidates", () => {
  it("collects the four documents of one subproject in native order", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", "{}\n")
    await f.write("A/opencode.jsonc", "{}\n")
    await f.write("A/.opencode/opencode.json", "{}\n")
    await f.write("A/.opencode/opencode.jsonc", "{}\n")

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    // The scan's list order is canonical-path order; `document` carries the A8 rank.
    expect(summary(result.agentConfigs)).toEqual([
      "A:.opencode/opencode.json",
      "A:.opencode/opencode.jsonc",
      "A:opencode.json",
      "A:opencode.jsonc",
    ])
    expect(result.agentConfigs.map((candidate) => candidate.canonicalPath)).toEqual([
      await realpath(join(f.root, "A/.opencode", "opencode.json")),
      await realpath(join(f.root, "A/.opencode", "opencode.jsonc")),
      await realpath(join(f.root, "A/opencode.json")),
      await realpath(join(f.root, "A/opencode.jsonc")),
    ])
    for (const candidate of result.agentConfigs) {
      expect(f.rel(candidate.path)).toBe(`A/${candidate.document}`)
      expect(candidate.subprojectRealPath).toBe(await realpath(join(f.root, "A")))
      expect(candidate.markers).toEqual(["opencode-project"])
    }
    expect(CONFIG_DOCUMENT_ORDER).toEqual([
      "opencode.json",
      "opencode.jsonc",
      ".opencode/opencode.json",
      ".opencode/opencode.jsonc",
    ])
  })

  it("sorts by canonical path and is identical for a second run", async () => {
    const f = await fixture()
    await f.write("A/.opencode/opencode.jsonc", "{}\n")
    await f.write("A/opencode.jsonc", "{}\n")
    await f.write("B/opencode.json", "{}\n")

    const first = await scanSkills({ location: f.root })
    const second = await scanSkills({ location: f.root })

    const canonical = first.agentConfigs.map((candidate) => candidate.canonicalPath)
    expect(canonical).toEqual([...canonical].sort())
    expect(second.agentConfigs).toEqual(first.agentConfigs)
  })

  it("attributes each document to the directory that owns it, never to an ancestor", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", "{}\n")
    await f.write("A/A.1/opencode.json", "{}\n")

    const result = await scanSkills({ location: f.root })

    expect(summary(result.agentConfigs)).toEqual(["A/A.1:opencode.json", "A:opencode.json"])
    expect(result.agentConfigs[0]?.subprojectRealPath).toBe(await realpath(join(f.root, "A/A.1")))
  })

  it("collects nothing at the location itself (A12: native owns it)", async () => {
    const f = await fixture()
    await f.write("opencode.json", "{}\n")
    await f.write(".opencode/opencode.json", "{}\n")

    const result = await scanSkills({ location: f.root })

    expect(result.agentConfigs).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("collects a document once for a subproject marked only by .opencode", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/x/SKILL.md")
    await f.write("A/.opencode/opencode.jsonc", "{}\n")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates[0]?.markers).toEqual(["opencode-skills", "opencode-project"])
    expect(summary(result.agentConfigs)).toEqual(["A:.opencode/opencode.jsonc"])
  })

  it("collects only the four A3 names", async () => {
    const f = await fixture()
    await f.write("A/opencode.yaml", "{}\n")
    await f.write("A/config.json", "{}\n")
    await f.write("A/opencode.json.bak", "{}\n")
    await f.write("A/.opencode/other.json", "{}\n")
    await f.write("A/AGENTS.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agentConfigs).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("charges the document to the shared file budget", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", "{}\n")
    await f.write("A/.opencode/skills/x/SKILL.md")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFiles: 1 },
    })

    expect(result.truncated).toBe(true)
    expect(result.diagnostics).toEqual(["budget-files: maxFiles=1"])
    expect(result.candidates.length + result.agents.length + result.agentConfigs.length).toBe(1)
    expect(result.agentConfigs).toHaveLength(1)
  })

  it("refuses a symlinked config document without following it", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    const target = await outside.write("opencode.json", "{}\n")
    await f.symlink("A/opencode.json", target)

    const result = await scanSkills({ location: f.root })

    expect(result.agentConfigs).toEqual([])
    expect(result.diagnostics).toEqual(["config-symlink: A/opencode.json"])
  })

  it("reports opencode-project on a document-only directory", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/x/SKILL.md")
    await f.write("A/opencode.jsonc", "{}\n")

    const result = await scanSkills({ location: f.root })

    expect(result.agentConfigs).toHaveLength(1)
    expect(result.agentConfigs[0]?.markers).toContain("opencode-project")
  })

  it("leaves a location with no config document with an empty list", async () => {
    const f = await fixture()
    await f.write("A/.opencode/skills/x/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agentConfigs).toEqual([])
    expect(result.diagnostics).toEqual([])
  })
})
