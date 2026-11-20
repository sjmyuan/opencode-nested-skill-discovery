import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { fakeContext } from "./support/fake-context.ts"
import { createRegistryFixture, type RegistryFixture } from "./support/registry-fixtures.ts"
import { createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

/**
 * F16 Step 7 (ADR agent A11, A14, A15): the existing index stage decodes and indexes both
 * agent sources with the one shared `FamilyPass`, publishes their diagnostics, and never
 * lets the agent stage fail the refresh. `registry.agents` is the additive observable.
 */

const control = vi.hoisted(() => ({ failure: undefined as Error | undefined }))

vi.mock("../src/agent-index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-index.ts")>()
  return {
    ...actual,
    indexAgents: async (input: Parameters<typeof actual.indexAgents>[0]) => {
      if (control.failure !== undefined) throw control.failure
      return actual.indexAgents(input)
    },
  }
})

beforeEach(() => {
  control.failure = undefined
})

interface Harness {
  readonly fixture: RegistryFixture
  readonly registry: ReturnType<typeof createRegistry>
  readonly agents: ReturnType<typeof fakeContext>["agentCalls"]
  dispose(): Promise<void>
}

async function harness(seed: (fixture: RegistryFixture) => Promise<void>): Promise<Harness> {
  const fixture = await createRegistryFixture()
  await seed(fixture)
  const fake = fakeContext([], { directory: fixture.root })
  const registry = createRegistry(fake.ctx, { now: () => 0 })
  await registry.activate()

  return {
    fixture,
    registry,
    agents: fake.agentCalls,
    async dispose() {
      await registry.dispose()
      await fixture.cleanup()
    },
  }
}

const withConfigs = async (fixture: RegistryFixture): Promise<void> => {
  await fixture.write(
    "A/opencode.json",
    JSON.stringify({ agents: { translator: { description: "d", mode: "subagent" } } }),
  )
  await fixture.write(
    "A/.opencode/opencode.jsonc",
    JSON.stringify({ agents: { translator: { description: "override" }, reviewer: {} } }),
  )
}

describe("the index stage publishes both agent sources", () => {
  it("merges a config-only subproject in native order", async () => {
    const h = await harness(withConfigs)

    try {
      expect(h.registry.agents).toHaveLength(2)
      const translator = h.registry.agents.find((agent) => agent.name === "translator")
      expect(translator?.description).toBe("override")
      expect(translator?.mode).toBe("subagent")
      expect(translator?.source).toBe("config")
      expect(translator?.canonicalPath).toBe(await h.fixture.realpathOf("A/opencode.json"))
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-merge:"))).toEqual([
        "agent-merge: translator (A/opencode.json + A/.opencode/opencode.jsonc)",
      ])
      expect(h.registry.outcome.ok).toBe(true)
    } finally {
      await h.dispose()
    }
  })

  it("lets the first source own the token while the file still supplies system", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write("A/opencode.json", JSON.stringify({ agents: { writer: { description: "declared" } } }))
      await fixture.write("A/.opencode/agent/writer.md", "---\ndescription: file\n---\nfile body\n")
    })

    try {
      expect(h.registry.agents).toHaveLength(1)
      const [writer] = h.registry.agents
      expect(writer?.source).toBe("config")
      expect(writer?.canonicalPath).toBe(await h.fixture.realpathOf("A/opencode.json"))
      expect(writer?.system).toBe("file body")
    } finally {
      await h.dispose()
    }
  })

  it("carries the subproject's top-level permissions on a file-only agent of that subproject", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({ permissions: [{ action: "bash", resource: "a", effect: "allow" }] }),
      )
      await fixture.write("A/.opencode/agent/writer.md", "---\ndescription: d\n---\nbody\n")
      await fixture.write("B/opencode.json", JSON.stringify({ agents: { other: {} } }))
    })

    try {
      const writer = h.registry.agents.find((agent) => agent.name === "writer")
      const other = h.registry.agents.find((agent) => agent.name === "other")
      expect(writer?.subprojectPermissions).toEqual([{ action: "bash", resource: "a", effect: "allow" }])
      expect(other?.subprojectPermissions).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it("ignores default_agent with one diagnostic", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write(
        "A/opencode.json",
        JSON.stringify({ default_agent: "build", agents: { translator: { description: "d" } } }),
      )
    })

    try {
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-default-ignored:"))).toEqual([
        "agent-default-ignored: A/opencode.json",
      ])
      expect(h.registry.agents.map((agent) => agent.name)).toEqual(["translator"])
    } finally {
      await h.dispose()
    }
  })

  it("makes no ctx.agent call", async () => {
    const h = await harness(withConfigs)

    try {
      expect(h.agents).toEqual([])
    } finally {
      await h.dispose()
    }
  })
})

describe("isolation", () => {
  it("keeps the refresh ok when the agent stage throws", async () => {
    const h = await harness(async (fixture) => {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy\n")
      await fixture.write("A/.opencode/command/release.md", "---\ndescription: r\n---\nrelease\n")
      await fixture.write("A/opencode.json", JSON.stringify({ agents: { translator: {} } }))
    })
    control.failure = new Error("agent stage exploded")

    try {
      await h.registry.refresh()

      expect(h.registry.outcome.ok).toBe(true)
      expect(h.registry.outcome.skills).toBe(1)
      expect(h.registry.agents).toEqual([])
      expect(h.registry.outcome.diagnostics.filter((line) => line.startsWith("agent-index:"))).toEqual([
        "agent-index: agent stage exploded",
      ])
    } finally {
      await h.dispose()
    }
  })

  it("leaves skills, commands and the snapshot untouched by an agent fixture", async () => {
    const plain = await harness(async (fixture) => {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy\n")
      await fixture.write("A/.opencode/command/release.md", "---\ndescription: r\n---\nrelease\n")
    })
    const withAgents = await harness(async (fixture) => {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", "---\nname: deploy\n---\n# Deploy\n")
      await fixture.write("A/.opencode/command/release.md", "---\ndescription: r\n---\nrelease\n")
      await fixture.write("A/opencode.json", JSON.stringify({ agents: { translator: { description: "d" } } }))
      await fixture.write("A/.opencode/agent/sibling.md", "---\ndescription: s\n---\nbody\n")
    })

    try {
      expect(withAgents.registry.outcome.skills).toBe(plain.registry.outcome.skills)
      expect(withAgents.registry.outcome.commands).toBe(plain.registry.outcome.commands)
      expect(withAgents.registry.agents).toHaveLength(2)
      // Two temp roots, so compare what publication owns: the entry set per subproject.
      const shape = (registry: typeof plain.registry) =>
        registry.snapshot.snapshots.map((snapshot) => ({
          subproject: snapshot.directory.slice(snapshot.directory.lastIndexOf("/") + 1),
          skills: snapshot.skills.map((skill) => skill.name),
        }))
      expect(shape(withAgents.registry)).toEqual(shape(plain.registry))
    } finally {
      await plain.dispose()
      await withAgents.dispose()
    }
  })
})

describe("family", () => {
  it("suppresses a worktree's config-declared agent and stays ok", async () => {
    const ws: FamilyWorkspace = await createFamilyWorkspace()
    await ws.repo("main")
    await ws.worktree("wt", "main", "linked")
    for (const checkout of ["main", "wt"]) {
      await ws.write(`${checkout}/opencode.json`, JSON.stringify({ agents: { declared: { description: checkout } } }))
    }
    const fake = fakeContext([], { directory: ws.root })
    const registry = createRegistry(fake.ctx, { now: () => 0 })

    try {
      await registry.activate()
      const wtReal = await realpath(join(ws.root, "wt"))

      expect(registry.outcome.ok).toBe(true)
      expect(registry.agents.map((agent) => agent.subproject)).toEqual(["main"])
      expect(registry.outcome.diagnostics.filter((line) => line.startsWith("family:"))).toEqual([
        `family: suppressed opencode.json from ${wtReal} (survivor ${await realpath(join(ws.root, "main"))} has it)`,
      ])
    } finally {
      await registry.dispose()
      await ws.cleanup()
    }
  })
})
