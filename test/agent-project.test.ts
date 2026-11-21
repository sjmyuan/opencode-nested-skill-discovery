import { describe, expect, it } from "vitest"
import type { IndexedAgent } from "../src/agent-index.ts"
import { admitAgents, expandHome, expandPermissions, projectAgent } from "../src/agent-project.ts"

/**
 * F17 Step 3 (ADR agent G2–G7, G12): a candidate becomes one registration payload with
 * native semantics — qualified sanitized name, sanitized description, verbatim mode and
 * hidden, `~` expansion on the three path actions, appended ruleset, key-assigned request.
 * The cases below are the rule table.
 */

const HOME = "/home/test"

function candidate(overrides: Partial<IndexedAgent> = {}): IndexedAgent {
  return {
    id: "A/writer",
    name: "writer",
    canonicalPath: "/root/A/.opencode/agent/writer.md",
    subproject: "A",
    subprojectRealPath: "/root/A",
    source: "file",
    subprojectPermissions: [],
    ...overrides,
  }
}

const rule = (action: string, resource: string, effect: "allow" | "deny" | "ask" = "allow") => ({
  action,
  resource,
  effect,
})

describe("carried fields", () => {
  it("carries the native fields and drops colour and disabled", () => {
    const projected = projectAgent(
      candidate({
        system: "own prompt",
        description: "a description",
        model: { providerID: "anthropic", id: "claude", variant: "fast" },
        steps: 4,
        mode: "subagent",
        hidden: true,
        color: "red",
        disabled: true,
      }),
      HOME,
    )

    expect(projected).toEqual({
      id: "A/writer",
      nativeName: "writer",
      name: "A/writer",
      system: "own prompt",
      description: "a description",
      model: { providerID: "anthropic", id: "claude", variant: "fast" },
      steps: 4,
      mode: "subagent",
      hidden: true,
      permissions: [],
      request: { headers: {}, body: {} },
    })
  })
})

describe("name", () => {
  it("qualifies with the location-relative subproject", () => {
    const projected = projectAgent(candidate({ subproject: "A/A.1", name: "writer" }), HOME)

    expect(projected.name).toBe("A/A.1/writer")
  })

  it("leaves a location-own candidate unqualified", () => {
    expect(projectAgent(candidate({ subproject: "", name: "writer" }), HOME).name).toBe("writer")
  })

  it("strips markup from the invented native name", () => {
    expect(projectAgent(candidate({ name: '<b>&"x"' }), HOME).name).toBe("A/bx")
  })

  it("caps at 80 characters, keeping the tail segments behind an ellipsis", () => {
    const projected = projectAgent(
      candidate({ subproject: `${"a".repeat(40)}/${"b".repeat(40)}`, name: "c".repeat(40) }),
      HOME,
    )

    expect(projected.name).toBe(`…/${"c".repeat(40)}`)
  })

  it("caps a single over-long segment at 80 and never uses the name as the ID", () => {
    const projected = projectAgent(candidate({ subproject: "p".repeat(70), name: "n".repeat(120) }), HOME)

    expect(Array.from(projected.name)).toHaveLength(80)
    expect(projected.name.startsWith("…/")).toBe(true)
    expect(projected.name).not.toBe(projected.id)
    expect(projected.id).toBe("A/writer")
  })
})

describe("description", () => {
  it("caps at 500 characters", () => {
    expect(projectAgent(candidate({ description: "d".repeat(600) }), HOME).description).toHaveLength(500)
  })

  it("strips markup and controls and collapses newlines", () => {
    const projected = projectAgent(candidate({ description: 'a<b>"c"&d\n\te\u0000f' }), HOME)

    expect(projected.description).toBe("abcd ef")
  })

  it("synthesizes nothing for an absent description", () => {
    expect(projectAgent(candidate(), HOME)).not.toHaveProperty("description")
  })
})

describe("mode and hidden", () => {
  it.each(["all", "primary", "subagent"] as const)("carries an authored mode of %s verbatim", (mode) => {
    expect(projectAgent(candidate({ mode }), HOME).mode).toBe(mode)
  })

  it("carries an authored hidden flag", () => {
    expect(projectAgent(candidate({ hidden: true }), HOME).hidden).toBe(true)
  })

  it("omits both when absent, so the registry default applies", () => {
    const projected = projectAgent(candidate(), HOME)

    expect(projected).not.toHaveProperty("mode")
    expect(projected).not.toHaveProperty("hidden")
  })
})

describe("ruleset order", () => {
  it("puts the subproject rules before the agent's own, in source order", () => {
    const projected = projectAgent(
      candidate({
        subprojectPermissions: [rule("bash", "one", "allow")],
        permissions: [rule("read", "two", "deny"), rule("edit", "three", "ask")],
      }),
      HOME,
    )

    expect(projected.permissions).toEqual([
      rule("bash", "one", "allow"),
      rule("read", "two", "deny"),
      rule("edit", "three", "ask"),
    ])
  })

  it("is empty when neither set carries rules", () => {
    expect(projectAgent(candidate(), HOME).permissions).toEqual([])
  })
})

describe("home expansion", () => {
  it.each([
    ["~", HOME],
    ["$HOME", HOME],
    ["~/x", "/home/test/x"],
    ["$HOME/x", "/home/test/x"],
    ["$HOME\\x", "/home/test/x"],
    ["/etc/x", "/etc/x"],
    ["~user/x", "~user/x"],
    ["**/~", "**/~"],
  ])("expands %s to %s", (resource, expected) => {
    expect(expandHome(resource, HOME)).toBe(expected)
  })

  it.each(["external_directory", "read", "edit"])("rewrites a home resource on %s", (action) => {
    expect(expandPermissions([rule(action, "~/x")], HOME)).toEqual([rule(action, "/home/test/x")])
  })

  it.each(["bash", "shell", "grep"])("leaves a home resource on %s untouched", (action) => {
    expect(expandPermissions([rule(action, "~/x")], HOME)).toEqual([rule(action, "~/x")])
  })

  it("expands the subproject rules and the agent's own rules alike", () => {
    const projected = projectAgent(
      candidate({ subprojectPermissions: [rule("read", "~/.ssh/**", "deny")], permissions: [rule("edit", "~/x")] }),
      HOME,
    )

    expect(projected.permissions).toEqual([
      rule("read", "/home/test/.ssh/**", "deny"),
      rule("edit", "/home/test/x"),
    ])
  })
})

describe("request", () => {
  it("copies the headers and the body key by key", () => {
    const projected = projectAgent(
      candidate({ request: { headers: { "x-a": "1", "x-b": "2" }, body: { temperature: 0.2, top_p: 0.9 } } }),
      HOME,
    )

    expect(projected.request).toEqual({ headers: { "x-a": "1", "x-b": "2" }, body: { temperature: 0.2, top_p: 0.9 } })
  })

  it("defaults to empty maps so the replay can always assign", () => {
    expect(projectAgent(candidate(), HOME).request).toEqual({ headers: {}, body: {} })
  })
})

describe("admission", () => {
  const display = (canonicalPath: string): string => canonicalPath.replace("/root/", "")
  const held = new Set<string>()

  it("emits nothing for an admitted source", () => {
    const result = admitAgents({ agents: [candidate()], home: HOME, held, display })

    expect(result.admitted.map((agent) => agent.name)).toEqual(["A/writer"])
    expect(result.diagnostics).toEqual([])
  })

  it("skips a disabled source with one line and admits it otherwise", () => {
    const disabled = admitAgents({ agents: [candidate({ disabled: true })], home: HOME, held, display })

    expect(disabled.admitted).toEqual([])
    expect(disabled.diagnostics).toEqual(["agent-skip: disabled A/.opencode/agent/writer.md"])
  })

  it("skips an ID the map already holds", () => {
    const result = admitAgents({
      agents: [candidate()],
      home: HOME,
      held: new Set([candidate().id]),
      display,
    })

    expect(result.admitted).toEqual([])
    expect(result.diagnostics).toEqual(["agent-skip: id-held A/.opencode/agent/writer.md"])
  })

  it("names a held ID that the audit reported as shadowed", () => {
    const result = admitAgents({
      agents: [candidate()],
      home: HOME,
      held: new Set([candidate().id]),
      shadowed: new Set([candidate().id]),
      display,
    })

    expect(result.admitted).toEqual([])
    expect(result.diagnostics).toEqual(["agent-skip: shadowed A/.opencode/agent/writer.md"])
  })

  it("uses the location-relative path of a config source", () => {
    const result = admitAgents({
      agents: [candidate({ source: "config", canonicalPath: "/root/A/opencode.json" })],
      home: HOME,
      held: new Set([candidate().id]),
      display,
    })

    expect(result.diagnostics).toEqual(["agent-skip: id-held A/opencode.json"])
  })

  it("does not treat a same-name pair in two subprojects as a skip", () => {
    const result = admitAgents({
      agents: [
        candidate({ id: "A/one", name: "one", subproject: "A", subprojectRealPath: "/root/A" }),
        candidate({ id: "B/two", name: "two", subproject: "B", subprojectRealPath: "/root/B" }),
      ],
      home: HOME,
      held,
      display,
    })

    expect(result.admitted.map((agent) => agent.name)).toEqual(["A/one", "B/two"])
    expect(result.diagnostics).toEqual([])
  })

  it("refuses a wildcard in the composed id", () => {
    const result = admitAgents({
      agents: [
        candidate({ id: "A/star*", name: "star*", canonicalPath: "/root/A/.opencode/agent/star*.md" }),
        candidate({ id: "A/q?", name: "q?", canonicalPath: "/root/A/.opencode/agent/q?.md" }),
        candidate({ id: "A/plain", name: "plain", canonicalPath: "/root/A/.opencode/agent/plain.md" }),
      ],
      home: HOME,
      held,
      display,
    })

    expect(result.admitted.map((agent) => agent.id)).toEqual(["A/plain"])
    expect(result.diagnostics).toEqual([
      "agent-skip: wildcard A/.opencode/agent/q?.md",
      "agent-skip: wildcard A/.opencode/agent/star*.md",
    ])
  })

  it("refuses the later of two sources composing one id", () => {
    const result = admitAgents({
      agents: [
        candidate({
          id: "A/x/y",
          name: "x/y",
          description: "from-A",
          canonicalPath: "/root/A/opencode.json",
          source: "config",
        }),
        candidate({
          id: "A/x/y",
          name: "y",
          description: "from-A-x",
          canonicalPath: "/root/A/x/.opencode/agent/y.md",
          subproject: "A/x",
          subprojectRealPath: "/root/A/x",
        }),
      ],
      home: HOME,
      held,
      display,
    })

    expect(result.admitted).toHaveLength(1)
    expect(result.admitted[0]?.id).toBe("A/x/y")
    expect(result.admitted[0]?.description).toBe("from-A")
    expect(result.diagnostics).toEqual(["agent-id-collision: A/x/y (A/opencode.json + A/x/.opencode/agent/y.md)"])
  })
})

describe("determinism", () => {
  it("produces ID-sorted, byte-identical output for the same input", () => {
    const agents = [
      candidate({ id: "B/second", name: "second", subproject: "B", subprojectRealPath: "/root/B", canonicalPath: "/root/B/second.md" }),
      candidate({ id: "A/first", name: "first", canonicalPath: "/root/A/first.md" }),
    ]
    const display = (canonicalPath: string): string => canonicalPath.replace("/root/", "")

    const first = admitAgents({ agents, home: HOME, held: new Set(), display })
    const second = admitAgents({ agents: [...agents].reverse(), home: HOME, held: new Set(), display })

    expect(first.admitted.map((agent) => agent.id)).toEqual(["A/first", "B/second"])
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
