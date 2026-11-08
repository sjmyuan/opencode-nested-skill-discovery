import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createPlacement } from "../src/placement.ts"
import type { FakeContext, FakeSessionSeed, FakeToolSeed } from "./support/fake-context.ts"
import { fakeContext } from "./support/fake-context.ts"

const INPUT = {
  type: "object",
  properties: {
    agent: { type: "string" },
    description: { type: "string" },
    prompt: { type: "string" },
  },
  required: ["agent", "description", "prompt"],
}

interface ExecuteContext {
  readonly sessionID: string
  readonly signal: AbortSignal
  readonly progress: (update: Record<string, unknown>) => Promise<void>
}

type Execute = (input: unknown, context: ExecuteContext) => Promise<unknown>

const executeOf = (fake: FakeContext): Execute => (fake.tool("subagent") as { execute: Execute }).execute

interface HarnessOptions {
  readonly sessions?: readonly FakeSessionSeed[]
}

interface Harness {
  readonly fake: FakeContext
  readonly root: string
  readonly destination: string
  readonly events: string[]
  readonly forwarded: Record<string, unknown>[]
  readonly received: unknown[]
  readonly results: unknown[]
  readonly placement: ReturnType<typeof createPlacement>
  execute(input: Record<string, unknown>): Promise<unknown>
}

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "placement-move-")))
  const destination = join(root, "dest")
  mkdirSync(destination)

  const events: string[] = []
  const forwarded: Record<string, unknown>[] = []
  const received: unknown[] = []
  const results: unknown[] = []
  let fake: FakeContext

  const native = async (input: Record<string, unknown>, context: ExecuteContext) => {
    received.push(input)
    const child =
      input.sessionID === undefined
        ? await fake.ctx.session.create({ parentID: context.sessionID, title: input.description })
        : await fake.ctx.session.get({ sessionID: String(input.sessionID) })
    events.push("progress")
    await context.progress({ sessionID: String(child.id), status: "running" })
    await fake.ctx.session.prompt({ sessionID: String(child.id), text: String(input.prompt) })
    events.push("prompt")
    const result = { output: "done", sessionID: String(child.id) }
    results.push(result)
    return result
  }

  const tool: FakeToolSeed = { id: "subagent", description: "native", input: INPUT, execute: native }
  fake = fakeContext([], {
    directory: root,
    tools: [tool],
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    onSessionOperation: (operation) => events.push(operation),
  })
  const placement = createPlacement(fake.ctx)
  await placement.activate()

  const execute = (input: Record<string, unknown>): Promise<unknown> =>
    executeOf(fake)(input, {
      sessionID: "parent",
      signal: new AbortController().signal,
      progress: async (update) => {
        events.push("forwarded")
        forwarded.push(update)
      },
    })

  return { fake, root, destination, events, forwarded, received, results, placement, execute }
}

const order = (events: readonly string[], expected: readonly string[]): boolean => {
  let index = 0
  for (const event of events) {
    if (event === expected[index]) index += 1
    if (index === expected.length) return true
  }
  return false
}

describe("placement: the child moves inside the awaited progress", () => {
  it("moves the new child, confirms, then forwards progress and prompts", async () => {
    const h = await harness()
    const result = await h.execute({ agent: "general", description: "task", prompt: "do it", directory: h.destination })

    expect(order(h.events, ["progress", "move", "get", "forwarded", "prompt"])).toBe(true)
    expect(h.fake.moves).toEqual([{ sessionID: "child-1", directory: h.destination }])
    expect(h.forwarded).toEqual([{ sessionID: "child-1", status: "running" }])
    expect(h.fake.prompts.map((prompt) => prompt.text)).toEqual(["do it"])
    expect(result).toBe(h.results[0])
  })

  it("does not move a child that already sits at the destination", async () => {
    const h = await harness()
    const child = await h.fake.ctx.session.create({ parentID: "parent" })
    await h.fake.ctx.session.move({ sessionID: String(child.id), directory: h.destination })
    h.fake.setMoveMode("reject")

    await h.execute({
      agent: "general",
      description: "task",
      prompt: "again",
      sessionID: String(child.id),
      directory: h.destination,
    })

    expect(h.fake.moves).toHaveLength(1)
    expect(h.fake.prompts.map((prompt) => prompt.sessionID)).toEqual([String(child.id)])
  })

  it("waits for a held move before prompting", async () => {
    const h = await harness()
    h.fake.setMoveMode("hold")
    let settled = false
    const running = h
      .execute({ agent: "general", description: "task", prompt: "go", directory: h.destination })
      .finally(() => {
        settled = true
      })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.fake.prompts).toHaveLength(0)
    expect(settled).toBe(false)

    h.fake.releaseMove()
    await running

    expect(h.fake.prompts).toHaveLength(1)
    expect(h.fake.moves).toEqual([{ sessionID: "child-1", directory: h.destination }])
  })

  it("re-places a continuation and leaves a plain continuation alone", async () => {
    const h = await harness({ sessions: [{ id: "child-9", location: { directory: "/elsewhere" } }] })
    h.fake.setLocation(h.root)

    await h.execute({
      agent: "general",
      description: "task",
      prompt: "carry on",
      sessionID: "child-9",
      directory: h.destination,
    })
    expect(h.fake.moves).toEqual([{ sessionID: "child-9", directory: h.destination }])
    expect(h.fake.prompts.map((prompt) => prompt.sessionID)).toEqual(["child-9"])

    const before = h.fake.moves.length
    await h.execute({ agent: "general", description: "task", prompt: "plain", sessionID: "child-9" })
    expect(h.fake.moves).toHaveLength(before)
  })

  it("passes an empty or omitted directory to the native tool unchanged", async () => {
    const h = await harness()

    for (const directory of ["", undefined]) {
      const input = { agent: "general", description: "task", prompt: "native", directory }
      await h.execute(input)
      const seen = h.received.at(-1) as Record<string, unknown>
      expect("directory" in seen).toBe(false)
      expect(seen).toMatchObject({ agent: "general", description: "task", prompt: "native" })
    }

    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(2)
  })
})
