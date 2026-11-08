import { describe, expect, it } from "vitest"
import { locationTokenFor, scopeTokenFor } from "../src/indexer.ts"

const SHAPE = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/

describe("location token", () => {
  it("matches the scope-token formula on the same path", () => {
    expect(locationTokenFor("/work/ws")).toBe("ws-fce99486")
    expect(locationTokenFor("/work/ws")).toBe(scopeTokenFor("/work/ws"))
    expect(locationTokenFor("/work/ws/a")).toBe("a-4942297c")
  })

  it("separates a location from a subproject inside it", () => {
    expect(locationTokenFor("/loc/root")).toBe("root-070405af")
    expect(locationTokenFor("/loc/root/A")).toBe("a-d74b151f")
    expect(locationTokenFor("/loc/root")).not.toBe(locationTokenFor("/loc/root/A"))
  })

  it("caps the slug at 24 characters without a trailing separator", () => {
    expect(locationTokenFor("/Users/ganggang/work/opencode-nested-skill-discovery")).toBe(
      "opencode-nested-skill-di-74d563df",
    )
  })

  it("falls back to x when the path has no basename", () => {
    expect(locationTokenFor("/")).toBe("x-8a5edab2")
  })

  it("is a single safe key segment", () => {
    const tokens = [
      "/",
      "/work/ws",
      "/work/ws/a",
      "/loc/root",
      "/loc/root/A",
      "/Users/ganggang/work/opencode-nested-skill-discovery",
    ].map((location) => locationTokenFor(location))

    for (const token of tokens) {
      expect(token).toMatch(SHAPE)
      expect(token).not.toContain("/")
      expect(token.length).toBeLessThanOrEqual(33)
    }
  })

  it("is deterministic and case-sensitive", () => {
    expect(locationTokenFor("/loc/root")).toBe(locationTokenFor("/loc/root"))
    expect(locationTokenFor("/loc/root")).not.toBe(locationTokenFor("/LOC/root"))
  })
})
