import { rm } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { composeCommandNames, type QualifiedCommand } from "../src/command-names.ts"
import { buildCommandSnapshot } from "../src/command-snapshot.ts"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import { scanCommands } from "./support/command-family-fixtures.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

const workspaces: FamilyWorkspace[] = []

const workspace = async (): Promise<FamilyWorkspace> => {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const commandPath = "A/.opencode/command/deploy.md"

const doc = (frontmatter: string, body = "# Deploy\n\nDeploys releases.\n"): string =>
  `---\n${frontmatter}\n---\n${body}`

const qualified = async (
  ws: FamilyWorkspace,
  location: string = ws.root,
): Promise<readonly QualifiedCommand[]> => {
  const scanned = await scanCommands(ws, location)
  return composeCommandNames(scanned, location).commands
}

describe("command snapshot", () => {
  it("S1: groups commands by the subproject scope token with the subproject directory", async () => {
    const ws = await workspace()
    await ws.write(commandPath, doc("description: Deploys"))

    const built = await buildCommandSnapshot({ location: ws.root, commands: await qualified(ws) })

    expect(built.snapshot).toMatchObject({ location: ws.root })
    expect(built.snapshot.snapshots).toHaveLength(1)
    expect(built.snapshot.snapshots[0]).toMatchObject({
      directory: path.join(ws.root, "A"),
      commands: [{ name: "A:deploy" }],
    })
    expect(built.diagnostics).toEqual([])
  })

  it("S2: carries template, description, agent, model and subagent into the entry", async () => {
    const ws = await workspace()
    const body = "\n# Deploy\n\nDeploys releases.\n"
    await ws.write(
      commandPath,
      doc('description: "Deploys releases"\nagent: build\nmodel: anthropic/claude\nsubagent: true', body),
    )

    const built = await buildCommandSnapshot({ location: ws.root, commands: await qualified(ws) })
    const entry = built.snapshot.snapshots[0]?.commands[0]

    expect(entry).toEqual({
      name: "A:deploy",
      canonicalPath: path.join(ws.root, commandPath),
      description: "Deploys releases",
      agent: "build",
      model: "anthropic/claude",
      subagent: true,
      template: body,
    })
  })

  it("S3: a malformed command is dropped with one diagnostic and its siblings publish", async () => {
    const ws = await workspace()
    await ws.write(commandPath, doc("description: [a, b]"))
    await ws.write("A/.opencode/command/release.md", doc("description: Releases"))

    const built = await buildCommandSnapshot({ location: ws.root, commands: await qualified(ws) })

    expect(built.snapshot.snapshots[0]?.commands.map((entry) => entry.name)).toEqual(["A:release"])
    expect(built.diagnostics).toHaveLength(1)
    expect(built.diagnostics[0]).toMatch(/^command-frontmatter: A\/\.opencode\/command\/deploy\.md: /)
  })

  it("S4: an unreadable command is dropped", async () => {
    const ws = await workspace()
    await ws.write(commandPath, doc("description: Deploys"))
    const commands = await qualified(ws)
    await rm(path.join(ws.root, commandPath))

    const built = await buildCommandSnapshot({ location: ws.root, commands })

    expect(built.snapshot.snapshots).toEqual([])
    expect(built.diagnostics).toEqual([`unreadable: ${commandPath} (ENOENT)`])
  })

  it("S5: a file over the per-file budget is dropped with command-oversize", async () => {
    const ws = await workspace()
    await ws.write(commandPath, doc("description: Deploys"))
    const commands = await qualified(ws)
    await ws.write(commandPath, "x".repeat(DEFAULT_SCAN_LIMITS.maxFileBytes + 1))

    const built = await buildCommandSnapshot({ location: ws.root, commands })

    expect(built.snapshot.snapshots).toEqual([])
    expect(built.diagnostics).toEqual([`command-oversize: ${commandPath}`])
  })

  it("S6: an empty input yields an empty frozen snapshot set", async () => {
    const built = await buildCommandSnapshot({ location: "/loc/root", commands: [] })

    expect(built.snapshot.snapshots).toEqual([])
    expect(Object.isFrozen(built.snapshot)).toBe(true)
    expect(Object.isFrozen(built.snapshot.snapshots)).toBe(true)
  })

  it("S7: the snapshot is frozen and deterministic", async () => {
    const ws = await workspace()
    await ws.write(commandPath, doc("description: Deploys"))
    await ws.write("A/.opencode/command/release.md", doc("description: Releases"))
    const commands = await qualified(ws)

    const forward = await buildCommandSnapshot({ location: ws.root, commands })
    const reversed = await buildCommandSnapshot({ location: ws.root, commands: [...commands].reverse() })

    expect(reversed.snapshot).toEqual(forward.snapshot)
    const record = forward.snapshot.snapshots[0]
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record?.commands)).toBe(true)
    for (const entry of record?.commands ?? []) expect(Object.isFrozen(entry)).toBe(true)
  })

  it("S8: two subprojects of one location get distinct tokens", async () => {
    const ws = await workspace()
    await ws.write("A/.opencode/command/deploy.md", doc("description: Deploys"))
    await ws.write("A.1/.opencode/command/deploy.md", doc("description: Deploys"))

    const built = await buildCommandSnapshot({ location: ws.root, commands: await qualified(ws) })
    const tokens = built.snapshot.snapshots.map((snapshot) => snapshot.scopeToken)

    expect(tokens).toHaveLength(2)
    expect(new Set(tokens).size).toBe(2)
    expect(built.snapshot.snapshots.map((snapshot) => snapshot.commands[0]?.name)).toEqual([
      "A.1:deploy",
      "A:deploy",
    ])
  })
})
