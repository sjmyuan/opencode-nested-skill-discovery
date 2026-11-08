import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { RegistrySnapshot, Snapshot } from "../src/contracts.ts"
import { createPlacement } from "../src/placement.ts"
import type {
  FakeContext,
  FakePermissionOutcome,
  FakeSessionSeed,
  FakeToolSeed,
} from "./support/fake-context.ts"
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
  readonly messageID?: string
  readonly id?: string
  readonly signal: AbortSignal
  readonly progress: (update: Record<string, unknown>) => Promise<void>
}

type Execute = (input: unknown, context: ExecuteContext) => Promise<unknown>

const executeOf = (fake: FakeContext): Execute => (fake.tool("subagent") as { execute: Execute }).execute

const entry = (id: string) => ({ id, canonicalPath: `/skills/${id}/SKILL.md`, name: id, content: "" })

const scope = (directory: string, ids: readonly string[]): Snapshot => ({
  scopeToken: directory.replaceAll("/", "-"),
  directory,
  skills: ids.map(entry),
})

const registryOf = (root: string): RegistrySnapshot => ({
  location: root,
  snapshots: [
    scope(root, ["nested.root.parent"]),
    scope(join(root, "A"), ["nested.a.deploy", "nested.a.audit"]),
    scope(join(root, "A", "deep"), ["nested.deep.one"]),
    scope(join(root, "B"), ["nested.b.sibling"]),
  ],
})

const EXPECTED_IDS = ["nested.a.audit", "nested.a.deploy", "nested.deep.one"]

interface HarnessOptions {
  readonly permission?: FakePermissionOutcome
  readonly snapshot?: RegistrySnapshot
  readonly sessions?: readonly FakeSessionSeed[]
}

interface Harness {
  readonly fake: FakeContext
  readonly root: string
  readonly destination: string
  readonly events: string[]
  readonly forwarded: Record<string, unknown>[]
  readonly results: unknown[]
  execute(input: Record<string, unknown>): Promise<unknown>
}

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "placement-gate-")))
  const destination = join(root, "A")
  mkdirSync(destination)
  const snapshot = options.snapshot ?? registryOf(root)

  const events: string[] = []
  const forwarded: Record<string, unknown>[] = []
  const results: unknown[] = []
  let fake: FakeContext

  const native = async (raw: unknown, context: ExecuteContext) => {
    const input = raw as Record<string, unknown>
    const child =
      input.sessionID === undefined
        ? await fake.ctx.session.create({ parentID: context.sessionID, title: String(input.description) })
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
    onPermissionAssert: () => events.push("assert"),
  })
  if (options.permission !== undefined) fake.setPermission(options.permission)
  const placement = createPlacement(fake.ctx, { readSnapshot: () => snapshot })
  await placement.activate()

  const execute = (input: Record<string, unknown>): Promise<unknown> =>
    executeOf(fake)(input, {
      sessionID: "parent",
      messageID: "message-1",
      id: "call-1",
      signal: new AbortController().signal,
      progress: async (update) => {
        events.push("forwarded")
        forwarded.push(update)
      },
    })

  return { fake, root, destination, events, forwarded, results, execute }
}

const order = (events: readonly string[], expected: readonly string[]): boolean => {
  let index = 0
  for (const event of events) {
    if (event === expected[index]) index += 1
    if (index === expected.length) return true
  }
  return false
}

describe("placement gate: one batched skill assert before the move", () => {
  it("asserts the destination's indexed nested IDs with the call session, the child agent and a tool source", async () => {
    const h = await harness()

    await h.execute({ agent: "general", description: "task", prompt: "do it", directory: h.destination })

    expect(h.fake.permissionCalls).toHaveLength(1)
    const call = h.fake.permissionCalls[0]
    expect(call).toEqual({
      sessionID: "parent",
      agent: "general",
      action: "skill",
      resources: EXPECTED_IDS,
      source: { type: "tool", messageID: "message-1", id: "call-1" },
    })
    expect(call?.save).toBeUndefined()
  })

  it("asserts once for the set, not once per ID", async () => {
    const h = await harness()

    await h.execute({ agent: "general", description: "task", prompt: "do it", directory: h.destination })

    expect(h.fake.permissionCalls).toHaveLength(1)
    expect(h.fake.permissionCalls[0]?.resources).toHaveLength(EXPECTED_IDS.length)
  })

  it("asserts before the move and before the prompt", async () => {
    const h = await harness()

    await h.execute({ agent: "general", description: "task", prompt: "do it", directory: h.destination })

    expect(order(h.events, ["progress", "assert", "move", "get", "forwarded", "prompt"])).toBe(true)
  })

  it("leaves the containing scope and the sibling scope out of the batch", async () => {
    const h = await harness()

    await h.execute({ agent: "general", description: "task", prompt: "do it", directory: h.destination })

    const resources = h.fake.permissionCalls[0]?.resources ?? []
    expect(h.fake.permissionCalls).toHaveLength(1)
    expect(resources).not.toContain("nested.root.parent")
    expect(resources).not.toContain("nested.b.sibling")
  })

  it("places the child and returns the native result when the assert allows", async () => {
    const h = await harness()

    const result = await h.execute({ agent: "general", description: "task", prompt: "do it", directory: h.destination })

    expect(h.fake.moves).toEqual([{ sessionID: "child-1", directory: h.destination }])
    expect(h.fake.permissionCalls).toHaveLength(1)
    expect(h.forwarded).toEqual([{ sessionID: "child-1", status: "running" }])
    expect(h.fake.prompts.map((prompt) => prompt.text)).toEqual(["do it"])
    expect(result).toBe(h.results[0])
  })
})
