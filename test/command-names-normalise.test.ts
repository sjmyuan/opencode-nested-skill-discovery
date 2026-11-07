import { describe, expect, it } from "vitest"
import { composeCommandName } from "../src/command-names.ts"

const NO_ELLIPSIS = "…"

describe("command name part normalisation", () => {
  it("turns a literal colon in either part into a hyphen", () => {
    expect(composeCommandName("a:b", "deploy")).toBe("a-b:deploy")
    expect(composeCommandName("sub", "review:pr")).toBe("sub:review-pr")
  })

  it("turns whitespace in either part into a hyphen", () => {
    expect(composeCommandName("run deploy", "x y")).toBe("run-deploy:x-y")
  })

  it("keeps one hyphen per whitespace character so a run is not collapsed", () => {
    expect(composeCommandName("run  deploy", "x")).toBe("run--deploy:x")
  })

  it("maps a tab to a hyphen before C0 stripping", () => {
    expect(composeCommandName("a\tb", "x")).toBe("a-b:x")
  })

  it("strips C0 controls from both parts", () => {
    expect(composeCommandName("\u0001a\u0000", "b\u0002")).toBe("a:b")
  })

  it("preserves case in both parts", () => {
    expect(composeCommandName("OpenCode", "Deploy")).toBe("OpenCode:Deploy")
  })

  it("never truncates a name longer than 160 characters", () => {
    const long = "a".repeat(200)

    const name = composeCommandName("", long)

    expect(name).toBe(long)
    expect(name).not.toContain(NO_ELLIPSIS)
  })
})
