import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RegistrySnapshot } from "../src/contracts.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"
import { fakeWatch } from "./support/watch-fixtures.ts"

vi.mock("@opencode/plugin", () => ({ Plugin: { define: (plugin: unknown) => plugin } }))

// Only the factory is replaced: the real registry wiring stays, but no test here waits on a
// real `fs.watch` event (PD12). `test/watch-node.test.ts` is the single factory smoke test.
const watchControl = vi.hoisted(() => ({
  factory: undefined as undefined | ((directory: string, onChange: () => void) => { close(): void }),
}))

vi.mock("../src/watch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/watch.ts")>()
  return {
    ...actual,
    nodeWatchFactory: (directory: string, onChange: () => void) => {
      const factory = watchControl.factory
      if (factory === undefined) return { close: () => undefined }
      return factory(directory, onChange)
    },
  }
})

const entry = await import("../index.ts")
const core = await import("../src/plugin.ts")

const DOC = "---\nname: deploy\n---\n# Deploy\n"
const EXTRA_DOC = "---\nname: extra\n---\n# Extra\n"

const subagentTool = {
  id: "subagent",
  description: "Spawns an agent in a child session.",
  input: {
    type: "object",
    properties: { agent: { type: "string" }, description: { type: "string" }, prompt: { type: "string" } },
    required: ["agent", "description", "prompt"],
  },
}

beforeEach(() => {
  watchControl.factory = undefined
})

describe("plugin definition", () => {
  it("default-exports only the id and setup", () => {
    expect(Object.keys(entry.default).sort()).toEqual(["id", "setup"])
    expect(entry.default.id).toBe("nested-skill-discovery")
  })

  it("registers exactly one skill transform and one prompt hook, and disposes both once", async () => {
    const fixture = await createRegistryFixture()

    try {
      const fake = fakeContext([], { directory: fixture.root, tools: [subagentTool] })
      const cleanup = await entry.default.setup(fake.ctx)

      expect(fake.transforms).toHaveLength(1)
      expect(fake.hookRegistrations).toBe(1)
      expect(fake.toolTransforms).toHaveLength(1)
      expect(cleanup).toBeTypeOf("function")
      if (typeof cleanup !== "function") return

      await cleanup()
      expect(fake.disposeCalls).toBe(1)
      expect(fake.hookDisposeCalls).toBe(1)
      expect(fake.toolDisposeCalls).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  it("refreshes from a watcher event without a second transform or hook", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      const fake = fakeContext([], { directory: fixture.root, tools: [subagentTool] })
      const watch = fakeWatch()
      watchControl.factory = watch.factory
      const cleanup = await entry.default.setup(fake.ctx)
      if (typeof cleanup !== "function") return

      try {
        expect(watch.active().length).toBeGreaterThan(0)
        await fake.firePrompt()
        await fixture.write("A/.opencode/skills/extra/SKILL.md", EXTRA_DOC)
        watch.emit()

        await vi.waitFor(
          () => expect(fake.editor.list().map((skill) => String(skill.name))).toContain("A/extra"),
          { timeout: 3000, interval: 20 },
        )

        expect(fake.transforms).toHaveLength(1)
        expect(fake.hookRegistrations).toBe(1)
        expect(fake.toolTransforms).toHaveLength(1)
        expect(fake.reloadCalls).toBeGreaterThan(1)
      } finally {
        await cleanup()
      }
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("snapshot replay", () => {
  it("adds the nested entry next to an untouched native entry", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      const seed = nativeSkill("native-alpha")
      const fake = fakeContext([seed], { directory: fixture.root })
      await entry.default.setup(fake.ctx)

      const listed = fake.editor.list()

      expect(listed).toHaveLength(2)
      expect(listed[0]).toEqual(seed)
      expect(listed[1]?.name).toBe("A/deploy")
      expect(String(listed[1]?.id).startsWith("nested.")).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("tolerates an undefined snapshot", () => {
    const fake = fakeContext()

    expect(() => core.applySnapshot(fake.editor, undefined)).not.toThrow()
  })

  it("is a no-op for an empty registry snapshot", () => {
    const fake = fakeContext([nativeSkill("native-alpha")])
    const before = fake.editor.list().map((skill) => ({ ...skill }))
    const empty: RegistrySnapshot = { location: "/loc/root", snapshots: [] }

    core.applySnapshot(fake.editor, empty)

    expect(fake.editor.list()).toEqual(before)
  })

  it("freezes the empty snapshot", () => {
    expect(Object.isFrozen(core.EMPTY_SNAPSHOT)).toBe(true)
    expect(Object.isFrozen(core.EMPTY_SNAPSHOT.skills)).toBe(true)
    expect(core.EMPTY_SNAPSHOT.skills).toHaveLength(0)
  })
})

describe("placement gate wiring", () => {
  it("feeds the live registry snapshot to the gate", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      let fake: ReturnType<typeof fakeContext>

      const native = async (
        raw: unknown,
        context: {
          readonly sessionID: string
          readonly signal: AbortSignal
          readonly progress: (update: Record<string, unknown>) => Promise<void>
        },
      ) => {
        const input = raw as Record<string, unknown>
        const child = await fake.ctx.session.create({ parentID: context.sessionID })
        await context.progress({ sessionID: String(child.id), status: "running" })
        await fake.ctx.session.prompt({ sessionID: String(child.id), text: String(input.prompt) })
        return { output: "done" }
      }

      fake = fakeContext([], {
        directory: fixture.realRoot,
        tools: [
          { id: "subagent", description: subagentTool.description, input: subagentTool.input, execute: native },
        ],
      })
      const cleanup = await entry.default.setup(fake.ctx)
      if (typeof cleanup !== "function") return

      try {
        const nested = fake
          .editor.list()
          .map((skill) => String(skill.id))
          .filter((id) => id.startsWith("nested.") && id.includes("deploy"))
        expect(nested).toHaveLength(1)

        const tool = fake.tool("subagent") as {
          execute: (input: unknown, context: Record<string, unknown>) => Promise<unknown>
        }
        await tool.execute(
          { agent: "general", description: "task", prompt: "do it", directory: join(fixture.realRoot, "A") },
          {
            sessionID: "parent",
            messageID: "message-1",
            id: "call-1",
            signal: new AbortController().signal,
            progress: async () => undefined,
          },
        )

        expect(fake.permissionCalls).toHaveLength(1)
        expect(fake.permissionCalls[0]?.agent).toBe("general")
        expect(fake.permissionCalls[0]?.resources).toContain(nested[0])
      } finally {
        await cleanup()
      }
    } finally {
      await fixture.cleanup()
    }
  })
})
