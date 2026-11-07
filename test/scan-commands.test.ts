import { afterEach, describe, expect, it } from "vitest"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
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

describe("command name derivation", () => {
  it("derives a root-level name from command/deploy.md", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/deploy.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toHaveLength(1)
    const [command] = result.commands
    expect(command).toMatchObject({
      name: "deploy",
      path: join(f.realRoot, "A/.opencode/command/deploy.md"),
      canonicalPath: await realpath(join(f.root, "A/.opencode/command/deploy.md")),
      subproject: "A",
      subprojectRealPath: await realpath(join(f.root, "A")),
      root: "opencode-command",
      markers: ["opencode-command"],
    })
    expect(command?.name).not.toContain(".md")
  })

  it("derives a nested name with POSIX separators from commands/review/pr.md", async () => {
    const f = await fixture()
    await f.write("A/.opencode/commands/review/pr.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]?.name).toBe("review/pr")
    expect(result.commands[0]?.root).toBe("opencode-commands")
    expect(result.commands[0]?.name).not.toContain("\\")
  })

  it("discovers both command roots in one subproject", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/a.md")
    await f.write("A/.opencode/commands/b/c.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => `${command.root}:${command.name}`)).toEqual([
      "opencode-command:a",
      "opencode-commands:b/c",
    ])
  })

  it("keeps dot files and dot directories", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/.draft.md")
    await f.write("A/.opencode/command/.archive/old.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands.map((command) => command.name)).toEqual([".archive/old", ".draft"])
  })
})

describe("command subproject attribution", () => {
  it("attributes a command to the nearest marked subproject", async () => {
    const f = await fixture()
    await f.write("A/AGENTS.md")
    await f.write("A/team/.opencode/command/one.md")
    await f.write("A/team/deep/CLAUDE.md")
    await f.write("A/team/deep/.opencode/command/two.md")

    const result = await scanSkills({ location: f.root })
    const found = result.commands.map((command) => ({
      name: command.name,
      subproject: command.subproject,
      subprojectRealPath: f.rel(command.subprojectRealPath),
      markers: command.markers,
    }))

    expect(found).toEqual([
      {
        name: "one",
        subproject: "A/team",
        subprojectRealPath: "A/team",
        markers: ["opencode-command"],
      },
      {
        name: "two",
        subproject: "A/team/deep",
        subprojectRealPath: "A/team/deep",
        markers: ["opencode-command", "claude-md"],
      },
    ])
  })

  it("treats a command-only directory as a subproject", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/x.md")

    const result = await scanSkills({ location: f.root })

    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]?.subproject).toBe("A")
    expect(result.commands[0]?.markers).toEqual(["opencode-command"])
    expect(result.commands[0]?.subprojectRealPath).toBe(await realpath(join(f.root, "A")))
  })
})
