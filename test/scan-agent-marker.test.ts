import { afterEach, describe, expect, it } from "vitest"
import { SUBPROJECT_MARKERS, type SubprojectMarker } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, type ScanFixture } from "./support/scan-fixtures.ts"

/**
 * F15 Step 2: the `opencode-project` marker (ADR agent A2, contract C1).
 *
 * A2 says the marker is a `Dirent` name test on the listing the walk already holds,
 * so every case here is observed through a candidate the same walk reports: the
 * marker must be visible in `markers`, assigned to the owning directory, without
 * changing the cost of the scan.
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

describe("opencode-project marker", () => {
  // A candidate can only live under `<dir>/.opencode/...`, so a `.opencode` sibling would
  // mask a config-document-only marking; a `.claude`/`.agents` root leaves the config
  // document as the sole source of `opencode-project`.
  it("marks a directory whose only project marker is a config document", async () => {
    const f = await fixture()
    await f.write("Q/opencode.jsonc", "{}\n")
    await f.write("Q/.claude/skills/x/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("Q")
    expect(result.candidates[0]?.markers).toEqual(["claude-skills", "opencode-project"])
  })

  for (const document of ["opencode.json", "opencode.jsonc"] as const) {
    it(`marks a directory from ${document} alone`, async () => {
      const f = await fixture()
      await f.write(`Q/${document}`, "{}\n")
      await f.write("Q/.agents/skills/y/SKILL.md")

      const result = await scanSkills({ location: f.root })

      expect(result.candidates[0]?.subproject).toBe("Q")
      expect(result.candidates[0]?.markers).toEqual(["agents-skills", "opencode-project"])
    })
  }

  it("does not mark a directory that carries neither a config document nor .opencode", async () => {
    const f = await fixture()
    await f.write("Q/.claude/skills/x/SKILL.md")

    const result = await scanSkills({ location: f.root })

    expect(result.candidates[0]?.subproject).toBe("Q")
    expect(result.candidates[0]?.markers).toEqual(["claude-skills"])
  })

  it("marks an agents-only directory from its .opencode entry", async () => {
    const f = await fixture()
    await f.write("A/.opencode/agent/x.md")
    await f.write("A/.opencode/command/y.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]?.subproject).toBe("A")
    expect(result.commands[0]?.markers).toEqual(["opencode-command", "opencode-project"])
  })

  // A2's observable intent: a `.opencode` holding only a mode directory marks the project,
  // because the `.opencode` Dirent is present — but no mode file is ever scanned and no
  // `mode`/`modes` marker kind exists.
  it("marks a .opencode-only directory and scans no mode files", async () => {
    const f = await fixture()
    await f.write("C/.opencode/mode/x.md")
    await f.write("C/.opencode/skills/s.md")

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    expect(result.candidates.map((candidate) => candidate.subproject)).toEqual(["C"])
    expect(result.candidates[0]?.markers).toEqual(["opencode-skills", "opencode-project"])
    // No mode file is a candidate of any kind; the full "zero agent candidates" claim is
    // `test/scan-agents.test.ts` (Step 3), which owns the agent branch of the walk.
    expect(result.candidates).toHaveLength(1)
    expect(result.commands).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(SUBPROJECT_MARKERS as readonly string[]).not.toContain("mode")
    expect(SUBPROJECT_MARKERS as readonly string[]).not.toContain("modes")
  })

  it("never marks a directory named .opencode as its own subproject", async () => {
    const f = await fixture()
    await f.write(".opencode/opencode.jsonc", "{}\n")
    await f.write(".opencode/mode/x.md")
    await f.write("A/.opencode/skills/x.md")

    const result = await scanSkills({ location: f.root })

    expect(result.diagnostics).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.subproject).toBe("A")
    for (const candidate of result.candidates) {
      expect(candidate.subproject.split("/")).not.toContain(".opencode")
    }
  })

  it("keeps opencode-project in SUBPROJECT_MARKERS order between the command kinds and agents-md", () => {
    const markers = SUBPROJECT_MARKERS as readonly SubprojectMarker[]
    const index = markers.indexOf("opencode-project")

    expect(index).toBeGreaterThan(markers.indexOf("opencode-commands"))
    expect(index).toBeLessThan(markers.indexOf("agents-md"))
    expect(markers.filter((marker) => marker === "opencode-project")).toHaveLength(1)
  })
})
