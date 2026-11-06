import { describe, expect, it } from "vitest"
import { composeName, sanitizeText, truncateName } from "../src/names.ts"

const length = (value: string): number => Array.from(value).length

const LONG_PATH = "packages/core/src/skill/deeply/nested/modules/feature-alpha/implementation-notes"
const C12_PATH = `${"a".repeat(50)}/${"b".repeat(21)}`
const C13_PATH = `${"a".repeat(51)}/${"b".repeat(21)}`
const C12_EXPECTED = `${C12_PATH}/skill-x`
const C13_EXPECTED = `…/${"b".repeat(21)}/skill-x`
const C14_EXPECTED = `…/${"y".repeat(77)}…`
const C15_EXPECTED = "…/core/src/skill/deeply/nested/modules/feature-alpha/implementation-notes/deploy"

describe("composeName", () => {
  it("C1 qualifies a typical subproject", () => {
    expect(composeName("opencode-v2.0.26", "effect")).toBe("opencode-v2.0.26/effect")
  })

  it("C2 qualifies a plain subproject", () => {
    expect(composeName("vscode", "launch")).toBe("vscode/launch")
  })

  it("C3 returns the bare name for an empty path", () => {
    expect(composeName("", "deploy")).toBe("deploy")
  })

  it("C4 drops empty path segments", () => {
    expect(composeName("/a//b/", "deploy")).toBe("a/b/deploy")
  })

  it("C5 returns the bare name for a separator-only path", () => {
    expect(composeName("///", "deploy")).toBe("deploy")
  })

  it("C6 collapses whitespace in the path", () => {
    expect(composeName("my  project", "x")).toBe("my project/x")
  })

  it("C7 collapses whitespace in the native name", () => {
    expect(composeName("a/b", "spaced   name")).toBe("a/b/spaced name")
  })

  it("C8 strips injection characters end to end", () => {
    expect(composeName('p"ath', "ev<il>&")).toBe("path/evil")
  })

  it("C9 keeps Unicode", () => {
    expect(composeName("ui", "ship 🚀")).toBe("ui/ship 🚀")
  })

  it("C10 survives degenerate input", () => {
    expect(composeName("", "")).toBe("")
  })

  it("C11 honours an explicit maxLength", () => {
    expect(composeName("aaa/bbb", "ccc", 10)).toBe("…/bbb/ccc")
  })

  it("C12 leaves a name of exactly 80 unchanged", () => {
    expect(composeName(C12_PATH, "skill-x")).toBe(C12_EXPECTED)
    expect(length(composeName(C12_PATH, "skill-x"))).toBe(80)
  })

  it("C13 truncates at 81", () => {
    expect(composeName(C13_PATH, "skill-x")).toBe(C13_EXPECTED)
    expect(length(composeName(C13_PATH, "skill-x"))).toBe(31)
  })

  it("C14 cuts an over-long native name", () => {
    expect(composeName("pkg", "y".repeat(80))).toBe(C14_EXPECTED)
    expect(length(composeName("pkg", "y".repeat(80)))).toBe(80)
  })

  it("C15 truncates a deep path", () => {
    expect(composeName(LONG_PATH, "deploy")).toBe(C15_EXPECTED)
    expect(length(composeName(LONG_PATH, "deploy"))).toBe(80)
  })

  it("disambiguates duplicate native names", () => {
    const pairs = [
      { native: "effect", left: "opencode-v2.0.26", right: "vscode" },
      { native: "opencode-dev", left: "packages/core", right: "packages/cli" },
      { native: "rtl-aware-development", left: "apps/web", right: "apps/desktop" },
      { native: "sample-skill", left: "a", right: "b" },
    ]

    for (const pair of pairs) {
      const left = composeName(pair.left, pair.native)
      const right = composeName(pair.right, pair.native)

      expect(left).toBe(`${pair.left}/${pair.native}`)
      expect(right).toBe(`${pair.right}/${pair.native}`)
      expect(left).not.toBe(right)
    }
  })

  it("exposes only the three display helpers", async () => {
    const names = await import("../src/names.ts")

    expect(Object.keys(names).sort()).toEqual(["composeName", "sanitizeText", "truncateName"])
  })

  it("returns a plain display string, never an id", () => {
    for (const [path, native] of [["", "effect"], ["a/b", "sample-skill"], ["pkg", "y".repeat(80)]] as const) {
      const name = composeName(path, native)

      expect(typeof name).toBe("string")
      expect(name.startsWith("nested.")).toBe(false)
      expect(sanitizeText(name, 80)).toBe(name)
      expect(truncateName(name)).toBe(name)
    }
  })
})
