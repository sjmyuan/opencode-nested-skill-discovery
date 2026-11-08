import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { RegistrySnapshot, Snapshot } from "../src/contracts.ts"
import { createPlacement, isPermissionDenial } from "../src/placement.ts"
import type {
  FakeContext,
  FakePermissionOutcome,
  FakeSessionSeed,
  FakeToolSeed,
} from "./support/fake-context.ts"
import {
  fakeContext,
  permissionCorrection,
  permissionDecline,
  permissionDenial,
} from "./support/fake-context.ts"

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
  readonly outside: string
  readonly placement: ReturnType<typeof createPlacement>
  readonly events: string[]
  readonly forwarded: Record<string, unknown>[]
  readonly results: unknown[]
  execute(input: Record<string, unknown>): Promise<unknown>
}

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "placement-gate-")))
  const destination = join(root, "A")
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "placement-gate-outside-")))
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

  return { fake, root, destination, outside, placement, events, forwarded, results, execute }
}

const order = (events: readonly string[], expected: readonly string[]): boolean => {
  let index = 0
  for (const event of events) {
    if (event === expected[index]) index += 1
    if (index === expected.length) return true
  }
  return false
}

const fieldOf = (message: string, label: string): string => {
  const start = message.indexOf(`${label}: `)
  if (start < 0) return "<missing>"
  const rest = message.slice(start + label.length + 2)
  const end = rest.search(/[,)]/)
  return end < 0 ? rest : rest.slice(0, end)
}

const ask = { agent: "general", description: "task", prompt: "do it" }

const rejectionOf = async (h: Harness): Promise<Error> => {
  const failure = await failureOf(h)
  expect(failure).toBeInstanceOf(Error)
  return failure as Error
}

const failureOf = (h: Harness): Promise<unknown> =>
  h.execute({ ...ask, directory: h.destination }).catch((error: unknown) => error)

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

describe("placement gate: a deny refuses the placement", () => {
  it("refuses without moving or prompting, and leaves the child created", async () => {
    const h = await harness({ permission: { kind: "deny" } })

    const failure = await rejectionOf(h)

    expect(failure.message).toMatch(/^Subagent placement denied/)
    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(0)
    expect(h.fake.childSessions).toHaveLength(1)
  })

  it("names the child, the destination, the observed location and the asserted count", async () => {
    const h = await harness({ permission: { kind: "deny" } })

    const message = (await rejectionOf(h)).message

    expect(fieldOf(message, "child session")).toBe("child-1")
    expect(fieldOf(message, "requested directory")).toBe(h.destination)
    expect(fieldOf(message, "observed location")).toBe(h.root)
    expect(message).toContain("3 indexed nested skills")
    expect(message).toContain("at least one is denied")
    expect(message.endsWith("The child stays created and unprompted; nothing was rolled back.")).toBe(true)
  })

  it("keeps the host error as the cause, by identity", async () => {
    const denial = permissionDenial("skill is denied")
    const h = await harness({ permission: { kind: "reject", error: denial } })

    const failure = await rejectionOf(h)

    expect(failure.cause).toBe(denial)
    expect(failure.message).toMatch(/^Subagent placement denied/)
  })

  it("keeps a custom deny reason reachable through the cause", async () => {
    const h = await harness({ permission: { kind: "deny", reason: "nested.a.deploy is denied" } })

    const failure = await rejectionOf(h)

    expect(failure.cause).toMatchObject({ error: { reason: "nested.a.deploy is denied" } })
  })

  it("recognises only a Tool.Error that carries a BlockedError", () => {
    expect(isPermissionDenial(permissionDenial("denied"))).toBe(true)
    expect(isPermissionDenial(permissionCorrection("change the agent"))).toBe(false)
    expect(isPermissionDenial(permissionDecline())).toBe(false)
    expect(isPermissionDenial(new Error("boom"))).toBe(false)
    expect(isPermissionDenial(undefined)).toBe(false)
    expect(isPermissionDenial({})).toBe(false)
  })
})

describe("placement gate: ask and the non-denial rejections", () => {
  const proceeds = async (outcome: FakePermissionOutcome): Promise<void> => {
    const h = await harness({ permission: outcome })

    const result = await h.execute({ ...ask, directory: h.destination })

    expect(h.fake.permissionCalls).toHaveLength(1)
    expect(h.fake.moves).toEqual([{ sessionID: "child-1", directory: h.destination }])
    expect(h.fake.prompts.map((prompt) => prompt.text)).toEqual(["do it"])
    expect(result).toBe(h.results[0])
  }

  it("proceeds on an allow", async () => {
    await proceeds({ kind: "allow" })
  })

  it("proceeds on an ask the user approves", async () => {
    await proceeds({ kind: "ask" })
  })

  it("rethrows a user decline unchanged instead of relabelling it as a deny", async () => {
    const decline = permissionDecline()
    const h = await harness({ permission: { kind: "reject", error: decline } })

    const failure = await failureOf(h)

    expect(failure).toBe(decline)
    expect(String((failure as { message?: string }).message ?? "")).not.toMatch(/Subagent placement denied/)
    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(0)
  })

  it("does not dress the host's own decline outcome as a deny", async () => {
    const h = await harness({ permission: { kind: "decline" } })

    const failure = (await failureOf(h)) as { _tag?: string; message?: string }

    expect(failure._tag).toBe("Permission.DeclinedError")
    expect(String(failure.message ?? "")).not.toMatch(/Subagent placement denied/)
    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(0)
  })

  it("rethrows a user correction unchanged", async () => {
    const correction = permissionCorrection("change the agent")
    const h = await harness({ permission: { kind: "reject", error: correction } })

    expect(await failureOf(h)).toBe(correction)
    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(0)
  })

  it("rethrows a missing-session rejection unchanged", async () => {
    const missing = {
      _tag: "Tool.Error",
      message: "Session not found: parent",
      error: { _tag: "Session.NotFoundError" },
    }
    const h = await harness({ permission: { kind: "reject", error: missing } })

    expect(await failureOf(h)).toBe(missing)
    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(0)
  })

  it("rethrows an unrecognised rejection unchanged", async () => {
    const boom = new Error("boom")
    const h = await harness({ permission: { kind: "reject", error: boom } })

    expect(await failureOf(h)).toBe(boom)
    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(0)
  })
})

describe("placement gate: the cases it cannot decide", () => {
  const emptySnapshot = (root: string): RegistrySnapshot => ({ location: root, snapshots: [] })

  it("skips the gate on an empty snapshot, names the destination and places the child", async () => {
    const h = await harness({ snapshot: emptySnapshot("") })

    await h.execute({ ...ask, directory: h.destination })

    expect(h.fake.permissionCalls).toHaveLength(0)
    expect(h.fake.moves).toHaveLength(1)
    const skipped = h.placement.diagnostics.filter((line) => line.includes("gate skipped: no indexed nested entries under"))
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toContain(h.destination)
  })

  it("skips the gate when every indexed scope sits outside the destination", async () => {
    const h = await harness({
      snapshot: {
        location: "",
        snapshots: [
          scope("/elsewhere/B", ["nested.b.other"]),
          scope("/elsewhere", ["nested.root.parent"]),
        ],
      },
    })

    await h.execute({ ...ask, directory: h.destination })

    expect(h.fake.permissionCalls).toHaveLength(0)
    expect(h.fake.moves).toHaveLength(1)
    expect(h.placement.diagnostics.join("\n")).toMatch(/gate skipped: no indexed nested entries under /)
  })

  it("skips the gate when the child agent is unknown and says so", async () => {
    for (const agent of [undefined, "", 7]) {
      const h = await harness()
      const input = { description: "task", prompt: "do it", directory: h.destination }
      await h.execute(agent === undefined ? input : { ...input, agent })

      expect(h.fake.permissionCalls).toHaveLength(0)
      expect(h.fake.moves).toHaveLength(1)
      expect(h.placement.diagnostics.join("\n")).toMatch(/gate skipped: the child agent is not known/)
    }
  })

  it("records an identical skip line once across repeated placements", async () => {
    const h = await harness({ snapshot: emptySnapshot("") })

    await h.execute({ ...ask, directory: h.destination })
    await h.execute({ ...ask, directory: h.destination })

    const skipped = h.placement.diagnostics.filter((line) => line.includes("gate skipped:"))
    expect(skipped).toHaveLength(1)
  })

  it("leaves a call without a directory byte-identical: no assert and no new diagnostic", async () => {
    const h = await harness()

    for (const directory of [undefined, ""]) {
      await h.execute({ agent: "general", description: "task", prompt: "native", directory })
    }

    expect(h.fake.permissionCalls).toHaveLength(0)
    expect(h.placement.diagnostics).toEqual([])
    expect(h.fake.moves).toHaveLength(0)
    expect(h.fake.prompts).toHaveLength(2)
  })

  it("does not assert for a destination the boundary refuses", async () => {
    const h = await harness()

    await expect(h.execute({ ...ask, directory: h.outside })).rejects.toThrow(/placement refused/)

    expect(h.fake.permissionCalls).toHaveLength(0)
    expect(h.fake.childSessions).toHaveLength(0)
  })
})
