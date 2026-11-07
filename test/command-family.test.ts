import { realpath, rm } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createFamilyPass } from "../src/family.ts"
import { filterCommandFamilies } from "../src/command-family.ts"
import { only } from "./support/indexer-fixtures.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"
import { scanCommands, writeCommand } from "./support/command-family-fixtures.ts"

const NESTED_CMD = "packages/app/.opencode/commands"

const workspaces: FamilyWorkspace[] = []

const workspace = async (): Promise<FamilyWorkspace> => {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const absolute = (ws: FamilyWorkspace, relativePath: string): string => path.join(ws.root, relativePath)

const familyDiagnostics = (diagnostics: readonly string[]): readonly string[] =>
  diagnostics.filter((line) => line.startsWith("family:"))

const filtered = async (ws: FamilyWorkspace, location: string = ws.root) =>
  filterCommandFamilies(await scanCommands(ws, location), { family: await createFamilyPass(location) })

describe("command candidates reuse the repo-family rule", () => {
  it("C1: drops a worktree-root command and keeps the survivor name byte-identical", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await writeCommand(ws, "main", "command", "deploy.md")
    await writeCommand(ws, "wt", "command", "deploy.md")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await filtered(ws)

    await rm(absolute(ws, "wt/.opencode/command/deploy.md"))
    const survivorOnly = await scanCommands(ws)

    expect(result.commands).toEqual(survivorOnly)
    expect(only(result.commands).name).toBe("deploy")
    expect(only(result.commands).path).toBe(absolute(ws, "main/.opencode/command/deploy.md"))
    expect(result.diagnostics).toEqual([
      `family: suppressed .opencode/command/deploy.md from ${wtReal} (survivor ${mainReal} has it)`,
    ])
  })

  it("C2: drops a nested worktree command and pairs on the checkout-relative path", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await writeCommand(ws, "main/packages/app", "commands", "tidy.md")
    await writeCommand(ws, "wt/packages/app", "commands", "tidy.md")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await filtered(ws)

    expect(result.commands).toHaveLength(1)
    expect(only(result.commands).name).toBe("tidy")
    expect(only(result.commands).subproject).toBe("main/packages/app")
    expect(result.diagnostics).toHaveLength(1)
    const line = only(result.diagnostics)
    expect(line).toBe(
      `family: suppressed ${NESTED_CMD}/tidy.md from ${wtReal} (survivor ${mainReal} has it)`,
    )
    expect(line).not.toContain(`${wtReal}/${NESTED_CMD}`)
  })

  it("C3: drops a worktree-only command as missing at the survivor", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await writeCommand(ws, "main", "command", "deploy.md")
    await writeCommand(ws, "wt", "command", "tidy.md")
    const wtReal = await realpath(absolute(ws, "wt"))
    const mainReal = await realpath(absolute(ws, "main"))

    const result = await filtered(ws)

    expect(result.commands.map((command) => command.name)).toEqual(["deploy"])
    expect(result.diagnostics).toEqual([
      `family: suppressed .opencode/command/tidy.md from ${wtReal} (missing at survivor ${mainReal})`,
    ])
  })

  it("C4: emits one diagnostic per dropped command", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await writeCommand(ws, "main", "command", "deploy.md")
    for (const name of ["deploy", "tidy", "lint"]) await writeCommand(ws, "wt", "command", `${name}.md`)

    const result = await filtered(ws)

    expect(result.commands).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toHaveLength(3)
  })

  it("C5: never suppresses a submodule command by its parent repo", async () => {
    const ws = await workspace()
    await ws.repo("parent")
    const modules = await ws.mkdirp("parent/.git/modules/sub")
    await ws.write("sub/.git", `gitdir: ${modules}\n`)
    await writeCommand(ws, "parent", "command", "deploy.md")
    await writeCommand(ws, "sub", "command", "deploy.md")

    const result = await filtered(ws)

    expect(result.commands).toHaveLength(2)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("C6: keeps a sibling repo command silently", async () => {
    const ws = await workspace()
    await ws.repo("one")
    await ws.repo("two")
    await writeCommand(ws, "one", "command", "deploy.md")
    await writeCommand(ws, "two", "command", "deploy.md")

    const result = await filtered(ws)

    expect(result.commands).toHaveLength(2)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("C7: keeps both distinct subprojects of one repo", async () => {
    const ws = await workspace()
    await ws.repo("vscode")
    await writeCommand(ws, "vscode", "command", "launch.md")
    await writeCommand(ws, "vscode/extensions/copilot", "command", "launch.md")

    const result = await filtered(ws)

    expect(result.commands).toHaveLength(2)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("C8: keeps a command whose survivor is outside the location silently", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("ws/wt", "main", "linked")
    await writeCommand(ws, "ws/wt", "command", "deploy.md")

    const result = await filtered(ws, absolute(ws, "ws"))

    expect(result.commands).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("C9: keeps the pre-family commands with one diagnostic when .git is broken", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.write("wt/.git", "garbage\n")
    await writeCommand(ws, "main", "command", "deploy.md")
    await writeCommand(ws, "wt", "command", "deploy.md")
    const wtReal = await realpath(absolute(ws, "wt"))

    const result = await filtered(ws)

    expect(result.commands).toHaveLength(2)
    expect(result.diagnostics).toEqual([`family: ${wtReal}: no gitdir line`])
  })

  it("C10: keeps a command subproject with no .git ancestor silently", async () => {
    const ws = await workspace()
    await writeCommand(ws, "plain/packages/app", "command", "tidy.md")

    const result = await filtered(ws)

    expect(result.commands).toHaveLength(1)
    expect(familyDiagnostics(result.diagnostics)).toEqual([])
  })

  it("C11: shuffled input yields the same commands and diagnostics", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    for (const name of ["deploy", "tidy"]) await writeCommand(ws, "main", "command", `${name}.md`)
    for (const name of ["deploy", "lint"]) await writeCommand(ws, "wt", "command", `${name}.md`)
    const location = ws.root
    const commands = await scanCommands(ws)

    const pass = await createFamilyPass(location)
    const forward = await filterCommandFamilies(commands, { family: pass })
    const reversed = await filterCommandFamilies([...commands].reverse(), { family: pass })

    expect(reversed.commands).toEqual(forward.commands)
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
  })

  it("C12: returns an empty list unchanged with no diagnostics", async () => {
    const ws = await workspace()
    const pass = await createFamilyPass(ws.root)

    const result = await filterCommandFamilies([], { family: pass })

    expect(result).toEqual({ commands: [], diagnostics: [] })
  })
})
