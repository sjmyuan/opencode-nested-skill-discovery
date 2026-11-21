import { describe, expect, it } from "vitest"
import { buildModeSeed } from "../src/replay.ts"

/**
 * F20 (ADR agent G4: `adr-agent-02-agent-registration.md:89`): the inheritance seed holds the
 * rows the published snapshot does not own — membership, never a `nested.` prefix test. A
 * prefix test also drops a *native* entry that happens to start with `nested.`, which then
 * stops inheriting `mode`/`hidden`; membership is the only rule that names our own rows.
 */

const rows = [
  { id: "A/translator", mode: "subagent", hidden: true },
  { id: "nested.foo", mode: "all", hidden: false },
  { id: "general", mode: "subagent", hidden: false },
] as const

describe("buildModeSeed", () => {
  it("leaves out a row whose ID the published snapshot owns", () => {
    const seed = buildModeSeed(rows, new Set(["A/translator"]))

    expect(seed.has("A/translator")).toBe(false)
    expect([...seed.keys()]).toEqual(["nested.foo", "general"])
  })

  it("keeps a native row whose ID starts with nested.", () => {
    const seed = buildModeSeed(rows, new Set(["A/translator"]))

    expect(seed.get("nested.foo")).toEqual({ mode: "all", hidden: false })
  })

  it("carries the mode and hidden of every kept row", () => {
    const seed = buildModeSeed(rows, new Set())

    expect([...seed]).toEqual([
      ["A/translator", { mode: "subagent", hidden: true }],
      ["nested.foo", { mode: "all", hidden: false }],
      ["general", { mode: "subagent", hidden: false }],
    ])
  })
})
