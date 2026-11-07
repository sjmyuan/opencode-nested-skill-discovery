import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { composeCommandNames } from "../src/command-names.ts"
import type { CommandCandidate } from "../src/contracts.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, type ScanFixture } from "./support/scan-fixtures.ts"

const cleanups: Array<() => Promise<void>> = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function resolved(f: ScanFixture) {
  const scanned = await scanSkills({ location: f.realRoot })
  return composeCommandNames(scanned.commands, f.realRoot)
}

const published = (result: Awaited<ReturnType<typeof resolved>>): readonly string[] =>
  result.commands.map((entry) => entry.publishedName)

describe("plugin-internal command name collisions", () => {
  it("keeps the entry whose canonical path sorts first when two subprojects compose one name", async () => {
    const f = await fixture()
    await f.write("a:b/.opencode/command/c.md")
    await f.write("a-b/.opencode/command/c.md")

    const result = await resolved(f)

    expect(published(result)).toEqual(["a-b:c"])
    expect(result.commands[0]?.subproject).toBe("a-b")
  })

  it("omits each loser and reports one name-collision diagnostic naming its location-relative path", async () => {
    const f = await fixture()
    await f.write("a b/.opencode/command/c.md")
    await f.write("a-b/.opencode/command/c.md")
    await f.write("a:b/.opencode/command/c.md")

    const result = await resolved(f)

    expect(published(result)).toEqual(["a-b:c"])
    expect(result.diagnostics).toEqual([
      "name-collision: a-b:c (a-b/.opencode/command/c.md)",
      "name-collision: a-b:c (a:b/.opencode/command/c.md)",
    ])
  })

  it("keeps every entry when no two compose the same name", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/deploy.md")
    await f.write("B/.opencode/commands/deploy.md")

    const result = await resolved(f)

    expect(published(result)).toEqual(["A:deploy", "B:deploy"])
    expect(result.diagnostics).toEqual([])
  })

  it("returns the survivors in canonical-path order", async () => {
    const f = await fixture()
    await f.write("zeta/.opencode/command/deploy.md")
    await f.write("alpha/.opencode/command/deploy.md")

    const result = await resolved(f)

    expect(published(result)).toEqual(["alpha:deploy", "zeta:deploy"])
  })

  it("breaks a canonical-path tie by path so the outcome is deterministic", async () => {
    const f = await fixture()
    const target = await f.write("A/.opencode/command/deploy.md")
    await f.symlink("A/.opencode/command/alias.md", target)
    const real = await realpath(target)

    const result = await resolved(f)

    expect(result.commands.map((entry) => entry.canonicalPath)).toEqual([real, real])
    expect(published(result)).toEqual(["A:alias", "A:deploy"])
  })

  it("carries the native name in name and the composed name in publishedName", async () => {
    const f = await fixture()
    await f.write("opencode/.opencode/command/deploy.md")
    const scanned = await scanSkills({ location: f.realRoot })

    const result = composeCommandNames(scanned.commands, f.realRoot)
    const entry = result.commands[0]

    expect(entry?.name).toBe("deploy")
    expect(entry?.publishedName).toBe("opencode:deploy")
    expect(entry?.path).toBe(scanned.commands[0]?.path)
    expect(entry?.canonicalPath).toBe(scanned.commands[0]?.canonicalPath)
    expect(entry?.subproject).toBe(scanned.commands[0]?.subproject)
    expect(entry?.subprojectRealPath).toBe(scanned.commands[0]?.subprojectRealPath)
    expect(entry?.root).toBe(scanned.commands[0]?.root)
    expect(entry?.markers).toEqual(scanned.commands[0]?.markers)
  })

  it("returns an empty command list and no diagnostics for an empty candidate list", () => {
    const result = composeCommandNames([], "/nowhere")

    expect(result.commands).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("omits an entry whose composed name is empty with name-empty", () => {
    // F1 skips the location-own command roots, so this shape can only reach the resolver directly.
    const location = "/workspace"
    const candidate: CommandCandidate = {
      name: "",
      path: join(location, "A/.opencode/command/.md"),
      canonicalPath: join(location, "A/.opencode/command/.md"),
      subproject: "",
      subprojectRealPath: location,
      root: "opencode-command",
      markers: [],
    }

    const result = composeCommandNames([candidate], location)

    expect(result.commands).toEqual([])
    expect(result.diagnostics).toEqual(["name-empty: A/.opencode/command/.md"])
  })

  it("emits frozen-grammar diagnostics that carry no absolute path", async () => {
    const f = await fixture()
    await f.write("a b/.opencode/command/c.md")
    await f.write("a-b/.opencode/command/c.md")

    const result = await resolved(f)

    expect(result.diagnostics.length).toBeGreaterThan(0)
    for (const line of result.diagnostics) {
      expect(line).toMatch(/^[a-z-]+: /)
      expect(line).not.toContain(f.root)
      expect(line).not.toContain(f.realRoot)
    }
  })
})
