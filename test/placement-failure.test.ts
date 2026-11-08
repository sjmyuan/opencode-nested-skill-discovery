import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createPlacement } from "../src/placement.ts"
import type { FakeContext, FakeToolSeed } from "./support/fake-context.ts"
import { fakeContext } from "./support/fake-context.ts"

const INPUT = {
  type: "object",
  properties: { agent: { type: "string" }, description: { type: "string" }, prompt: { type: "string" } },
  required: ["agent", "description", "prompt"],
}

interface ExecuteContext {
  readonly sessionID: string
  readonly signal: AbortSignal
  readonly progress: (update: Record<string, unknown>) => Promise<void>
}

type Execute = (input: unknown, context: ExecuteContext) => Promise<unknown>

type NativeMode = "normal" | "prompt-first" | "silent"

const executeOf = (fake: FakeContext): Execute => (fake.tool("subagent") as { execute: Execute }).execute

const fieldOf = (message: string, label: string): string => {
  const start = message.indexOf(`${label}: `)
  if (start < 0) return "<missing>"
  const rest = message.slice(start + label.length + 2)
  const end = rest.search(/[,)]/)
  return end < 0 ? rest : rest.slice(0, end)
}

const harness = async (options: { mode?: NativeMode; timeoutMs?: number; pollMs?: number } = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "placement-failure-")))
  const destination = join(root, "dest")
  mkdirSync(destination)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "placement-outside-")))
  let fake: FakeContext
  let started = false

  const native = async (raw: unknown, context: ExecuteContext) => {
    started = true
    const input = raw as Record<string, unknown>
    const child = await fake.ctx.session.create({ parentID: context.sessionID, title: String(input.description) })
    const id = String(child.id)
    if (options.mode === "silent") {
      await fake.ctx.session.prompt({ sessionID: id, text: String(input.prompt) })
      return { output: "done" }
    }
    if (options.mode === "prompt-first") {
      await fake.ctx.session.prompt({ sessionID: id, text: String(input.prompt) })
      fake.markBusy(id)
      await context.progress({ sessionID: id, status: "running" })
      return { output: "done" }
    }
    await context.progress({ sessionID: id, status: "running" })
    await fake.ctx.session.prompt({ sessionID: id, text: String(input.prompt) })
    return { output: "done" }
  }

  const tool: FakeToolSeed = { id: "subagent", description: "native", input: INPUT, execute: native }
  fake = fakeContext([], { directory: root, tools: [tool] })
  const placement = createPlacement(fake.ctx, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  })
  await placement.activate()

  const execute = (directory: string): Promise<unknown> =>
    executeOf(fake)(
      { agent: "general", description: "task", prompt: "do it", directory },
      { sessionID: "parent", signal: new AbortController().signal, progress: async () => undefined },
    )

  const executeWith = (directory: string, signal: AbortSignal): Promise<unknown> =>
    executeOf(fake)(
      { agent: "general", description: "task", prompt: "do it", directory },
      { sessionID: "parent", signal, progress: async () => undefined },
    )

  return { fake, root, destination, outside, placement, execute, executeWith, started: () => started }
}

describe("placement failures", () => {
  it("refuses outside the boundary before the native tool runs", async () => {
    const h = await harness()
    await expect(h.execute(h.outside)).rejects.toThrow(/placement refused/)
    await expect(h.execute(join(h.root, "gone"))).rejects.toThrow(/placement refused/)

    expect(h.started()).toBe(false)
    expect(h.fake.childSessions).toHaveLength(0)
  })

  it("names the child, the requested directory and the observed location when the move fails", async () => {
    const h = await harness()
    h.fake.setMoveMode("reject", new Error("move rejected by host"))

    const failure = await h.execute(h.destination).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(fieldOf(message, "child session")).toBe("child-1")
    expect(fieldOf(message, "requested directory")).toBe(h.destination)
    expect(fieldOf(message, "observed location")).toBe(h.root)
    expect(message).not.toContain(`observed location: ${h.destination}`)
    expect(h.fake.prompts).toHaveLength(0)
  })

  it("bounds the whole phase by one budget, including the move call", async () => {
    const h = await harness({ timeoutMs: 20, pollMs: 5 })
    h.fake.setMoveMode("hold")

    const failure = await h.execute(h.destination).catch((error: unknown) => error)
    h.fake.releaseMove()

    const message = (failure as Error).message
    expect(message).toContain("not confirmed within 20ms")
    expect(message).toContain("may still be queued")
    expect(fieldOf(message, "child session")).toBe("child-1")
    expect(fieldOf(message, "requested directory")).toBe(h.destination)
    expect(fieldOf(message, "observed location")).toBe(h.root)
    expect(message).not.toContain(`observed location: ${h.destination}`)
    expect(h.fake.prompts).toHaveLength(0)
  })

  it("confirms a slow move when the budget is large enough to cover it", async () => {
    const h = await harness({ timeoutMs: 500, pollMs: 10 })
    h.fake.setMoveMode("hold")
    setTimeout(() => h.fake.releaseMove(), 30)

    await h.execute(h.destination)

    expect(h.fake.moves).toHaveLength(1)
    expect(h.fake.prompts).toHaveLength(1)
  })

  it("rejects a child that was already prompted, and a native that never reports it", async () => {
    const early = await harness({ mode: "prompt-first" })
    const late = await early.execute(early.destination).catch((error: unknown) => error)
    expect((late as Error).message).toContain("already started")
    expect((late as Error).message).toContain("child-1")

    const silent = await harness({ mode: "silent" })
    await expect(silent.execute(silent.destination)).rejects.toThrow(/did not report its child before prompting/)
  })

  it("rejects on abort without prompting", async () => {
    const h = await harness({ timeoutMs: 5000, pollMs: 5 })
    h.fake.setMoveMode("hold")
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)

    const failure = await h.executeWith(h.destination, controller.signal).catch((error: unknown) => error)
    h.fake.releaseMove()

    expect((failure as Error).message).toContain("aborted")
    expect(h.fake.prompts).toHaveLength(0)
  })
})
