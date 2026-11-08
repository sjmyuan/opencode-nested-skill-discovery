import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { createPlacement, GUIDANCE } from "../src/placement.ts"
import { fakeContext } from "./support/fake-context.ts"

const NATIVE_DESCRIPTION = "Spawns an agent in a child session to work on the specified task."

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
