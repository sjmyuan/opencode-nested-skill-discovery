import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import { resolveNativeAgentRoots } from "../src/native.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, type ScanFixture } from "./support/scan-fixtures.ts"

/**
 * F15 Step 4 (ADR agent A5, plan D5): a candidate whose **realpath** is inside a native
 * agent root is skipped at acceptance, before admission — silently, because native owns it —
 * and the same fixture without the option still yields the candidate.
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

describe("native agent root skip", () => {
  it("skips a subproject agent file whose realpath sits in the location's native root", async () => {
    const f = await fixture()
    await f.write(".opencode/agent/translator.md", "a")
    await f.symlink("A/.opencode/agent/alias.md", "../../../.opencode/agent/translator.md")
    const missing = join(f.root, "missing")

    const result = await scanSkills({
      location: f.root,
      agentNativeRoots: await resolveNativeAgentRoots({
        location: f.root,
        home: missing,
        configDirectory: missing,
      }),
    })

    expect(result.agents).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it("keeps the same candidate when the skip is not configured", async () => {
    const f = await fixture()
    await f.write(".opencode/agent/translator.md", "a")
    await f.symlink("A/.opencode/agent/alias.md", "../../../.opencode/agent/translator.md")

    const result = await scanSkills({ location: f.root })

    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]?.name).toBe("alias")
    expect(result.diagnostics).toEqual([])
  })

  it("never scans the location's own agent root even without the skip", async () => {
    const f = await fixture()
    await f.write(".opencode/agent/translator.md", "a")
    await f.write(".opencode/agents/second.md", "b")

    const result = await scanSkills({ location: f.root })

    expect(result.agents).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("skips a realpath owned by the global config directory, without charging the budget", async () => {
    const f = await fixture()
    // A config directory inside the location keeps the target in-location, so the
    // outside-symlink rule cannot mask the native skip.
    await f.write("cfg/agent/g.md", "a")
    await f.symlink("A/.opencode/agents/g-alias.md", "../../../cfg/agent/g.md")
    await f.write("B/.opencode/agent/keep.md", "b")

    const result = await scanSkills({
      location: f.root,
      limits: { ...DEFAULT_SCAN_LIMITS, maxFiles: 1 },
      agentNativeRoots: await resolveNativeAgentRoots({
        location: f.root,
        home: join(f.root, "missing"),
        configDirectory: join(f.root, "cfg"),
      }),
    })

    expect(result.agents.map((agent) => agent.subproject)).toEqual(["B"])
    expect(result.truncated).toBe(false)
    expect(result.diagnostics).toEqual([])
  })

  it("never skips a sibling subproject's own agent file", async () => {
    const f = await fixture()
    await f.write(".opencode/agent/translator.md", "a")
    await f.write("B/.opencode/agent/keep.md", "b")
    const missing = join(f.root, "missing")

    const result = await scanSkills({
      location: f.root,
      agentNativeRoots: await resolveNativeAgentRoots({
        location: f.root,
        home: missing,
        configDirectory: missing,
      }),
    })

    expect(result.agents.map((agent) => agent.subproject)).toEqual(["B"])
    expect(result.diagnostics).toEqual([])
  })
})
