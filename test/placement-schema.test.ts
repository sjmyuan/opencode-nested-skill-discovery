import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { createPlacement, GUIDANCE } from "../src/placement.ts"
import type { FakeToolExecute } from "./support/fake-context.ts"
import { fakeContext } from "./support/fake-context.ts"

const NATIVE_DESCRIPTION = "Spawns an agent in a child session to work on the specified task."

const DIRECTORY_DESCRIPTION = "Supply `directory` when the task belongs to a nested subproject or checkout and the child must be assembled from that destination's instructions, skills, agents, config and permissions; the child narrows to the destination and loses sibling subprojects. Omit it when the task belongs to the caller's own context and should keep the caller's current location and its union. The value is an absolute path or a path relative to the location serving the call, and a leading ~ expands to the home directory. The child moves before this task is admitted, so its first request runs at the destination. The destination must be inside this project or one of its worktrees. With sessionID a different directory moves the child again at the next boundary; history is preserved, but relative paths in it are not rewritten. A refused destination creates no child; a failure after the child exists leaves it created and unprompted and is not rolled back."

const nativeInput = () =>
  Schema.Struct({
    agent: Schema.String.annotate({ description: "agent" }),
    description: Schema.String.annotate({ description: "label" }),
    prompt: Schema.String.annotate({ description: "task" }),
    model: Schema.optionalKey(Schema.String).annotate({ description: "model" }),
    sessionID: Schema.optionalKey(Schema.String).annotate({ description: "continue" }),
    background: Schema.optionalKey(Schema.Boolean).annotate({ description: "background" }),
  })

const seed = () => ({
  id: "subagent",
  description: NATIVE_DESCRIPTION,
  input: nativeInput(),
})

const extended = (fake: ReturnType<typeof fakeContext>): Record<string, any> =>
  fake.tool("subagent") as Record<string, any>

describe("placement registration: schema extension", () => {
  it("adds only an optional directory and keeps every native property", async () => {
    const fake = fakeContext([], { tools: [seed()] })
    await createPlacement(fake.ctx).activate()

    expect(fake.toolTransforms).toHaveLength(1)
    const input = extended(fake).input
    expect(input.type).toBe("object")
    expect(input.properties.directory).toMatchObject({ type: "string", minLength: 1 })
    expect(String(input.properties.directory.description).length).toBeGreaterThan(0)
    expect(input.required).toEqual(["agent", "description", "prompt"])
    expect(Object.keys(input.properties).sort()).toEqual([
      "agent",
      "background",
      "description",
      "directory",
      "model",
      "prompt",
      "sessionID",
    ])
    expect(input.properties.model).toMatchObject({ type: "string", description: "model" })
    expect(input.properties.sessionID).toMatchObject({ type: "string", description: "continue" })
    expect(input.properties.background).toMatchObject({ type: "boolean", description: "background" })
  })

  it("states when to supply directory, not only what it does", async () => {
    const fake = fakeContext([], { tools: [seed()] })
    await createPlacement(fake.ctx).activate()

    const description = String(extended(fake).input.properties.directory.description)

    expect(description).toBe(DIRECTORY_DESCRIPTION)
    expect(description).toContain("Supply `directory` when the task belongs to a nested subproject or checkout")
    expect(description).toContain("Omit it when the task belongs to the caller's own context")
    expect(description).not.toContain(GUIDANCE)
  })

  it("appends the guidance once, leaves the tool mutable and disposes once", async () => {
    const fake = fakeContext([], { tools: [seed()] })
    const placement = createPlacement(fake.ctx)
    await placement.activate()

    const tool = extended(fake)
    expect(tool.description).toBe(`${NATIVE_DESCRIPTION}\n\n${GUIDANCE}`)
    expect(Object.isFrozen(tool)).toBe(false)

    await placement.dispose()
    expect(fake.toolDisposeCalls).toBe(1)

    const second = createPlacement(fake.ctx)
    await second.activate()
    const again = extended(fake)
    expect(again.description).toBe(`${NATIVE_DESCRIPTION}\n\n${GUIDANCE}`)
    expect(again.description.split(GUIDANCE)).toHaveLength(2)
  })

  it("wraps the executor it observed at activation, not what the tool object holds later", async () => {
    let nativeCalls = 0
    let sentinelCalls = 0
    const native: FakeToolExecute = async () => {
      nativeCalls += 1
      return { output: "native" }
    }
    const seeded = {
      id: "subagent",
      name: "subagent",
      description: NATIVE_DESCRIPTION,
      input: nativeInput(),
      execute: native,
    }
    const fake = fakeContext([], { tools: [seeded as never] })
    await createPlacement(fake.ctx).activate()

    const transform = fake.toolTransforms[0]
    if (transform === undefined) throw new Error("no transform registered")
    const hostile = {
      get: (id: string) => (id === "subagent" ? seeded : undefined),
      update: (id: string, change: (tool: Record<string, unknown>) => void) => {
        if (id !== "subagent") return
        change(seeded as unknown as Record<string, unknown>)
        seeded.name = "subagent"
        seeded.id = "subagent"
      },
    } as never
    await transform(hostile)

    const wrapped = seeded.execute
    const sentinel = async (): Promise<Record<string, string>> => {
      sentinelCalls += 1
      return { output: "sentinel" }
    }
    seeded.execute = sentinel

    const result = await wrapped(
      { agent: "general", description: "task", prompt: "do it" },
      { sessionID: "parent", signal: new AbortController().signal, progress: async () => undefined },
    )

    expect(sentinelCalls).toBe(0)
    expect(nativeCalls).toBe(1)
    expect(result).toEqual({ output: "native" })
  })

  it("skips without throwing when the native tool is absent", async () => {
    const fake = fakeContext()
    const placement = createPlacement(fake.ctx)

    await expect(placement.activate()).resolves.toBeUndefined()
    expect(fake.tool("subagent")).toBeUndefined()
    expect(placement.diagnostics).toHaveLength(1)
    expect(placement.diagnostics[0]).toContain("subagent")
  })

  it("skips a schema that already declares directory and keeps the other registration", async () => {
    const execute = async (): Promise<Record<string, never>> => ({})
    const input = Schema.Struct({
      agent: Schema.String,
      description: Schema.String,
      prompt: Schema.String,
      directory: Schema.optionalKey(Schema.String),
    })
    const fake = fakeContext([], {
      tools: [{ id: "subagent", description: NATIVE_DESCRIPTION, input, execute }],
    })
    await fake.ctx.skill.transform(() => undefined)
    const placement = createPlacement(fake.ctx)

    await expect(placement.activate()).resolves.toBeUndefined()
    expect(extended(fake).input).toBe(input)
    expect(extended(fake).execute).toBe(execute)
    expect(placement.diagnostics).toHaveLength(1)
    expect(placement.diagnostics[0]).toContain("directory")
    expect(fake.transforms).toHaveLength(1)
  })

  it("skips an input that is not an object schema", async () => {
    for (const input of [{ type: "array" }, undefined]) {
      const fake = fakeContext([], {
        tools: [{ id: "subagent", description: NATIVE_DESCRIPTION, input }],
      })
      const placement = createPlacement(fake.ctx)

      await expect(placement.activate()).resolves.toBeUndefined()
      expect(extended(fake).input).toBe(input)
      expect(placement.diagnostics).toHaveLength(1)
    }
  })
})
