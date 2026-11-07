import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_COMMAND_NAME_LENGTH, composeCommandNames } from "../src/command-names.ts"
import type { CommandCandidate } from "../src/contracts.ts"

const location = "/workspace"

function command(subproject: string, name: string): CommandCandidate {
  const path = join(location, subproject, ".opencode/command", `${name}.md`)

  return {
    name,
    path,
    canonicalPath: path,
    subproject,
    subprojectRealPath: join(location, subproject),
    root: "opencode-command",
    markers: [],
  }
}

const longOf = (length: number): string => "a".repeat(length)

describe("command name length", () => {
  it("registers a 160-character name without a diagnostic", () => {
    const name = longOf(MAX_COMMAND_NAME_LENGTH)

    const result = composeCommandNames([command("", name)], location)

    expect(result.commands.map((entry) => entry.publishedName)).toEqual([name])
    expect(result.diagnostics).toEqual([])
  })

  it("registers and logs a 161-character publishedName with name-too-long", () => {
    const name = longOf(MAX_COMMAND_NAME_LENGTH + 1)

    const result = composeCommandNames([command("", name)], location)

    expect(result.commands.map((entry) => entry.publishedName)).toEqual([name])
    expect(result.diagnostics).toEqual([`name-too-long: ${name}`])
  })

  it("returns the long publishedName unchanged with no ellipsis", () => {
    const name = longOf(MAX_COMMAND_NAME_LENGTH + 40)

    const result = composeCommandNames([command("sub", name)], location)

    expect(result.commands[0]?.publishedName).toBe(`sub:${name}`)
    expect(result.commands[0]?.publishedName).not.toContain("…")
  })

  it("measures code points so 160 astral characters are not reported", () => {
    const name = "😀".repeat(MAX_COMMAND_NAME_LENGTH)

    const result = composeCommandNames([command("", name)], location)

    expect(name.length).toBeGreaterThan(MAX_COMMAND_NAME_LENGTH)
    expect(result.commands[0]?.publishedName).toBe(name)
    expect(result.diagnostics).toEqual([])
  })

  it("never logs a long name that a collision omitted", () => {
    const name = longOf(MAX_COMMAND_NAME_LENGTH + 1)

    const result = composeCommandNames([command("a:b", name), command("a-b", name)], location)

    expect(result.commands.map((entry) => entry.publishedName)).toEqual([`a-b:${name}`])
    expect(result.diagnostics).toEqual([
      `name-collision: a-b:${name} (a:b/.opencode/command/${name}.md)`,
      `name-too-long: a-b:${name}`,
    ])
    expect(result.diagnostics.filter((line) => line.startsWith("name-too-long: "))).toHaveLength(1)
  })

  it("logs each long name once in canonical order", () => {
    const first = longOf(MAX_COMMAND_NAME_LENGTH + 1)
    const second = longOf(MAX_COMMAND_NAME_LENGTH + 2)

    const result = composeCommandNames([command("z", second), command("a", first)], location)

    expect(result.commands.map((entry) => entry.publishedName)).toEqual([`a:${first}`, `z:${second}`])
    expect(result.diagnostics).toEqual([`name-too-long: a:${first}`, `name-too-long: z:${second}`])
  })
})
