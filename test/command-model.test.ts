import { describe, expect, it } from "vitest"
import { canonicalModelSelection, modelRefOf, SUBAGENT_PREFIX } from "../src/command-model.ts"

describe("command model selection", () => {
  it("M1: provider/id becomes a provider and an id", () => {
    expect(modelRefOf("anthropic/claude-sonnet")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet",
    })
  })

  it("M2: provider/id#variant carries the variant", () => {
    expect(modelRefOf("anthropic/claude-sonnet#fast")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet",
      variant: "fast",
    })
  })

  it("M3: an id containing a slash keeps the rest as the id", () => {
    expect(modelRefOf("a/b/c")).toEqual({ providerID: "a", id: "b/c" })
    expect(modelRefOf("a/b/c#v")).toEqual({ providerID: "a", id: "b/c", variant: "v" })
  })

  it("M4: the mapping form canonicalises to the short string", () => {
    expect(canonicalModelSelection({ providerID: "anthropic", model: "claude-sonnet", variant: "fast" })).toBe(
      "anthropic/claude-sonnet#fast",
    )
    expect(canonicalModelSelection({ providerID: "anthropic", model: "claude-sonnet" })).toBe(
      "anthropic/claude-sonnet",
    )
  })

  it("M5: every value outside the pinned grammar is rejected", () => {
    for (const value of [
      "nonsense",
      "/model",
      "provider/",
      "provider/model#",
      "provider/model#a#b",
      "a#b/model",
      "",
    ]) {
      expect(modelRefOf(value), value).toBeUndefined()
    }

    expect(canonicalModelSelection("nonsense")).toBeUndefined()
    expect(canonicalModelSelection({ providerID: "", model: "x" })).toBeUndefined()
    expect(canonicalModelSelection({ providerID: "a/b", model: "x" })).toBeUndefined()
    expect(canonicalModelSelection({ providerID: "a#b", model: "x" })).toBeUndefined()
    expect(canonicalModelSelection({ providerID: "a", model: "" })).toBeUndefined()
    expect(canonicalModelSelection({ providerID: "a", model: "x#y" })).toBeUndefined()
    expect(canonicalModelSelection({ providerID: "a", model: "x", variant: "" })).toBeUndefined()
    expect(canonicalModelSelection({ providerID: "a", model: "x", variant: "b#c" })).toBeUndefined()
  })

  it("M6: the two directions round-trip", () => {
    for (const value of ["anthropic/claude-sonnet", "anthropic/claude-sonnet#fast", "a/b/c#v2"]) {
      const ref = modelRefOf(value)
      expect(ref).toBeDefined()
      if (ref === undefined) continue

      const canonical = canonicalModelSelection({
        providerID: ref.providerID,
        model: ref.id,
        ...(ref.variant === undefined ? {} : { variant: ref.variant }),
      })

      expect(canonical).toBe(value)
      if (canonical !== undefined) expect(modelRefOf(canonical)).toEqual(ref)
    }
  })

  it("M7: SUBAGENT_PREFIX is the platform's wording", () => {
    expect(SUBAGENT_PREFIX).toBe("You are a subagent spawned by another session.")
  })
})
