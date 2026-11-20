import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { CONFIG_DOCUMENT_ORDER, MAX_ID_LENGTH, type AgentCandidate } from "../src/contracts.ts"
import { agentTokenFor, indexAgents, type IndexedAgent } from "../src/agent-index.ts"
import { createFamilyPass, type FamilyPass } from "../src/family.ts"
import { scopeTokenFor, slug } from "../src/indexer.ts"
import { scanSkills } from "../src/scan.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"
import { createFixture, type ScanFixture } from "./support/scan-fixtures.ts"

/**
 * F16 Step 6 (ADR agent A6, A7, A8, A11, A14): one entry per (subproject, native name)
 * across both sources, merged in native document order, family-filtered before the ID is
 * minted, and identified by `nested.<scopeToken>.<agentToken>`.
 */

const cleanups: Array<() => Promise<void>> = []
const workspaces: FamilyWorkspace[] = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

async function workspace(): Promise<FamilyWorkspace> {
  const created = await createFamilyWorkspace()
  workspaces.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

afterAll(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()))
})

interface IndexOptions {
  readonly family?: FamilyPass
  readonly reverse?: boolean
  readonly agents?: readonly AgentCandidate[]
}

async function index(f: ScanFixture | FamilyWorkspace, options: IndexOptions = {}) {
  const scanned = await scanSkills({ location: f.root })
  const agents = options.agents ?? (options.reverse ? [...scanned.agents].reverse() : scanned.agents)
  const configs = options.reverse ? [...scanned.agentConfigs].reverse() : scanned.agentConfigs
  return indexAgents({
    location: await realpath(f.root),
    home: "/home/test",
    agents,
    configs,
    ...(options.family === undefined ? {} : { family: options.family }),
  })
}

const byName = (agents: readonly IndexedAgent[]): Readonly<Record<string, IndexedAgent>> =>
  Object.fromEntries(agents.map((agent) => [agent.name, agent]))

const sha8 = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8)

describe("native names and identity", () => {
  it("takes a config agent's native name from the map key, verbatim", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", JSON.stringify({ agents: { "review-tools/pr": { description: "d" } } }))
    await f.write("A/.opencode/agent/other.md", "---\ndescription: x\n---\nbody\n")

    const result = await index(f)

    expect(result.agents.map((agent) => `${agent.name}:${agent.source}`)).toEqual([
      "other:file",
      "review-tools/pr:config",
    ])
    expect(result.diagnostics).toEqual([])
  })

  it("hashes a file's realpath and the document's realpath plus the key", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", JSON.stringify({ agents: { translator: { description: "d" } } }))
    const file = await f.write("A/.opencode/agent/writer.md", "---\ndescription: x\n---\nbody\n")

    const result = await index(f)
    const config = byName(result.agents).translator
    const fileAgent = byName(result.agents).writer

    const documentReal = await realpath(join(f.root, "A/opencode.json"))
    expect(config?.id).toBe(
      `nested.${scopeTokenFor(await realpath(join(f.root, "A")))}.${slug("translator", 40)}-${sha8(`${documentReal}#translator`)}`,
    )
    expect(fileAgent?.id).toBe(
      `nested.${scopeTokenFor(await realpath(join(f.root, "A")))}.${slug("writer", 40)}-${sha8(await realpath(file))}`,
    )
    // Same native name, different hash input: the two tokens never collide.
    expect(agentTokenFor("translator", { kind: "config", configRealPath: documentReal, key: "translator" })).not.toBe(
      agentTokenFor("translator", { kind: "file", realPath: await realpath(file) }),
    )
  })

  it("keeps every id inside the grammar and the 96-character bound", async () => {
    const f = await fixture()
    const key = "a".repeat(40)
    const subproject = `s${"u".repeat(23)}`
    await f.write(`${subproject}/opencode.json`, JSON.stringify({ agents: { [key]: {} } }))
    await f.write(`${subproject}/.opencode/agent/${"b".repeat(40)}.md`, "---\ndescription: d\n---\nbody\n")

    const result = await index(f)

    expect(result.agents).toHaveLength(2)
    for (const agent of result.agents) {
      expect(agent.id).toMatch(/^nested\.[a-z0-9-]+\.[a-z0-9-]+$/)
      expect(agent.id.length).toBeLessThanOrEqual(MAX_ID_LENGTH)
      expect(agent.id).not.toContain("*")
      expect(agent.id).not.toContain("?")
    }
  })

  it("gives two subprojects that declare the same name distinct ids", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", JSON.stringify({ agents: { shared: { description: "a" } } }))
    await f.write("B/opencode.json", JSON.stringify({ agents: { shared: { description: "b" } } }))

    const result = await index(f)

    expect(result.agents).toHaveLength(2)
    const [first, second] = result.agents
    expect(first?.name).toBe("shared")
    expect(first?.id).not.toBe(second?.id)
    expect(first?.id).toContain(scopeTokenFor(await realpath(join(f.root, "A"))))
    expect(second?.id).toContain(scopeTokenFor(await realpath(join(f.root, "B"))))
  })

  it("sorts by id and is byte-identical for a reversed input", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", JSON.stringify({ agents: { two: { description: "2" } } }))
    await f.write("A/.opencode/agent/one.md", "---\ndescription: 1\n---\nbody\n")

    const forward = await index(f)
    const reversed = await index(f, { reverse: true })

    expect(forward.agents.map((agent) => agent.id)).toEqual([...forward.agents.map((agent) => agent.id)].sort())
    expect(reversed.agents).toEqual(forward.agents)
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
  })
})

describe("A8 native merge", () => {
  it("merges five sources into one entry owned by opencode.json", async () => {
    const f = await fixture()
    for (const document of CONFIG_DOCUMENT_ORDER) {
      await f.write(`A/${document}`, JSON.stringify({ agents: { shared: { description: document } } }))
    }
    await f.write("A/.opencode/agent/shared.md", "---\ndescription: file\n---\nfile body\n")

    const result = await index(f)
    const entry = byName(result.agents).shared

    expect(result.agents).toHaveLength(1)
    expect(entry?.source).toBe("config")
    expect(entry?.canonicalPath).toBe(await realpath(join(f.root, "A/opencode.json")))
    expect(entry?.description).toBe("file")
    expect(entry?.system).toBe("file body")
    expect(result.diagnostics).toEqual(["agent-merge: shared (A/opencode.json + A/opencode.jsonc + A/.opencode/opencode.json + A/.opencode/opencode.jsonc + A/.opencode/agent/shared.md)"])

    const reversed = await index(f, { reverse: true })
    expect(reversed.agents).toEqual(result.agents)
    expect(reversed.diagnostics).toEqual(result.diagnostics)
  })

  it("applies fields when present, appends permissions and assigns request keys", async () => {
    const f = await fixture()
    await f.write(
      "A/opencode.json",
      JSON.stringify({
        agents: {
          shared: {
            description: "first",
            model: { providerID: "openai", model: "gpt" },
            disabled: true,
            permissions: [{ action: "read", resource: "a/**", effect: "allow" }],
            request: { headers: { "x-a": "1" }, body: { temperature: 0.1 } },
          },
        },
      }),
    )
    await f.write(
      "A/.opencode/opencode.jsonc",
      JSON.stringify({
        agents: {
          shared: {
            mode: "subagent",
            permissions: [{ action: "read", resource: "b/**", effect: "deny" }],
            request: { headers: { "x-b": "2" }, body: { top_p: 0.9 } },
          },
        },
      }),
    )
    await f.write(
      "A/.opencode/agent/shared.md",
      [
        "---",
        "model: anthropic/claude",
        "hidden: true",
        "permissions:",
        "  - action: read",
        "    resource: c/**",
        "    effect: ask",
        "request:",
        "  headers:",
        "    x-c: '3'",
        "---",
        "file body",
        "",
      ].join("\n"),
    )

    const entry = byName((await index(f)).agents).shared

    // Last source that sets a field wins; an absent field is never erased.
    expect(entry?.description).toBe("first")
    expect(entry?.model).toEqual({ providerID: "anthropic", id: "claude" })
    expect(entry?.mode).toBe("subagent")
    expect(entry?.hidden).toBe(true)
    expect(entry?.disabled).toBe(true)
    expect(entry?.system).toBe("file body")
    expect(entry?.permissions).toEqual([
      { action: "read", resource: "a/**", effect: "allow" },
      { action: "read", resource: "b/**", effect: "deny" },
      { action: "read", resource: "c/**", effect: "ask" },
    ])
    expect(entry?.request).toEqual({ headers: { "x-a": "1", "x-b": "2", "x-c": "3" }, body: { temperature: 0.1, top_p: 0.9 } })
  })

  it("reports one merge line per merged name and none for a single source", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", JSON.stringify({ agents: { pair: { description: "a" }, solo: {} } }))
    await f.write("A/.opencode/agent/pair.md", "---\ndescription: b\n---\nbody\n")
    await f.write("A/.opencode/agent/solo-two.md", "---\ndescription: s\n---\nbody\n")

    const result = await index(f)

    expect(result.diagnostics.filter((line) => line.startsWith("agent-merge:"))).toEqual([
      "agent-merge: pair (A/opencode.json + A/.opencode/agent/pair.md)",
    ])
    expect(byName(result.agents).solo).toBeDefined()
  })

  it("prefixes a subproject's documents' permissions onto a file-derived agent only", async () => {
    const f = await fixture()
    await f.write(
      "A/opencode.json",
      JSON.stringify({ permissions: [{ action: "bash", resource: "one", effect: "allow" }] }),
    )
    await f.write(
      "A/.opencode/opencode.jsonc",
      JSON.stringify({ permissions: [{ action: "bash", resource: "two", effect: "deny" }] }),
    )
    await f.write("A/.opencode/agent/writer.md", "---\ndescription: d\n---\nbody\n")
    await f.write("B/opencode.json", JSON.stringify({ agents: { other: {} } }))

    const result = await index(f)

    expect(byName(result.agents).writer?.subprojectPermissions).toEqual([
      { action: "bash", resource: "one", effect: "allow" },
      { action: "bash", resource: "two", effect: "deny" },
    ])
    expect(byName(result.agents).other?.subprojectPermissions).toEqual([])
  })

  it("ignores default_agent with one diagnostic per document and publishes no entry for it", async () => {
    const f = await fixture()
    await f.write(
      "A/opencode.json",
      JSON.stringify({ default_agent: "build", agents: { one: { description: "d" } } }),
    )
    await f.write("A/.opencode/opencode.jsonc", JSON.stringify({ default_agent: "plan" }))
    await f.write("B/opencode.json", JSON.stringify({ default_agent: "build" }))

    const result = await index(f)

    expect(result.diagnostics.filter((line) => line.startsWith("agent-default-ignored:"))).toEqual([
      "agent-default-ignored: A/.opencode/opencode.jsonc",
      "agent-default-ignored: A/opencode.json",
      "agent-default-ignored: B/opencode.json",
    ])
    expect(result.agents.map((agent) => agent.name)).toEqual(["one"])
  })
})

describe("skips and isolation", () => {
  it("skips a malformed document, a schema-failing document and a legacy file", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", `{"agents": {`)
    await f.write("A/.opencode/opencode.jsonc", JSON.stringify({ agents: { bad: { mode: "nope" } } }))
    await f.write("A/.opencode/agent/legacy.md", "---\nname: old\ntools: [read]\n---\nbody\n")
    await f.write("A/.opencode/agent/kept.md", "---\ndescription: d\n---\nbody\n")

    const result = await index(f)

    expect(result.agents.map((agent) => agent.name)).toEqual(["kept"])
    expect(result.diagnostics).toEqual([
      "agent-skip: legacy A/.opencode/agent/legacy.md",
      "agent-skip: malformed A/opencode.json",
      "agent-skip: schema A/.opencode/opencode.jsonc",
    ])
  })

  it("never throws on an unreadable document and reports one diagnostic", async () => {
    const f = await fixture()
    await f.write("A/opencode.json", JSON.stringify({ agents: { hidden: {} } }))
    await f.chmod("A/opencode.json", 0o000)

    const result = await index(f)

    expect(result.agents).toEqual([])
    expect(result.diagnostics).toEqual(["agent-skip: unreadable A/opencode.json: EACCES"])
  })
})

describe("family filtering on both sources", () => {
  it("suppresses a worktree's config and file agents and keeps the main checkout's", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    for (const checkout of ["main", "wt"]) {
      await ws.write(`${checkout}/opencode.json`, JSON.stringify({ agents: { declared: { description: checkout } } }))
      await ws.write(`${checkout}/.opencode/agent/declared.md`, "---\ndescription: file\n---\nbody\n")
      await ws.write(`${checkout}/.opencode/agent/fileonly.md`, "---\ndescription: f\n---\nbody\n")
    }
    const mainReal = await realpath(join(ws.root, "main"))
    const wtReal = await realpath(join(ws.root, "wt"))

    const result = await index(ws)

    expect(result.agents.map((agent) => agent.name)).toEqual(["declared", "fileonly"])
    expect(result.agents.every((agent) => agent.subproject === "main")).toBe(true)
    // The merge runs before the family stage, so the suppressed worktree line names the
    // entry's token owner (`opencode.json`), not the file that was merged into it.
    expect(result.diagnostics).toEqual([
      "agent-merge: declared (main/opencode.json + main/.opencode/agent/declared.md)",
      "agent-merge: declared (wt/opencode.json + wt/.opencode/agent/declared.md)",
      `family: suppressed .opencode/agent/fileonly.md from ${wtReal} (survivor ${mainReal} has it)`,
      `family: suppressed opencode.json from ${wtReal} (survivor ${mainReal} has it)`,
    ])
  })

  it("uses the shared family pass once per index call", async () => {
    const ws = await workspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    await ws.write("main/opencode.json", JSON.stringify({ agents: { declared: {} } }))
    await ws.write("wt/opencode.json", JSON.stringify({ agents: { declared: {} } }))
    const pass = await createFamilyPass(ws.root)
    let derives = 0
    const spy: FamilyPass = {
      location: pass.location,
      derive: async (checkouts) => {
        derives += 1
        return pass.derive(checkouts)
      },
    }

    const result = await index(ws, { family: spy })

    expect(derives).toBe(1)
    expect(result.agents).toHaveLength(1)
  })
})
