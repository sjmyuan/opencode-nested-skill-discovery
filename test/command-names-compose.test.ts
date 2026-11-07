import { describe, expect, it } from "vitest"
import { composeCommandName } from "../src/command-names.ts"

describe("qualified command name composition", () => {
  it("composes opencode and deploy as opencode:deploy", () => {
    expect(composeCommandName("opencode", "deploy")).toBe("opencode:deploy")
  })

  it("composes sub and deploy/rollback as sub:deploy:rollback", () => {
    expect(composeCommandName("sub", "deploy/rollback")).toBe("sub:deploy:rollback")
  })

  it("composes vscode/extensions/copilot and review/pr as vscode:extensions:copilot:review:pr", () => {
    expect(composeCommandName("vscode/extensions/copilot", "review/pr")).toBe(
      "vscode:extensions:copilot:review:pr",
    )
  })

  it("replaces every slash with a colon so the composed name never holds a second slash", () => {
    const name = composeCommandName("a/b", "c/d/e")

    expect(name).toBe("a:b:c:d:e")
    expect(name.split("/")).toHaveLength(1)
  })

  it("composes an unqualified name when the subproject is empty", () => {
    expect(composeCommandName("", "deploy")).toBe("deploy")
  })

  it("composes the single part when the native name is empty", () => {
    expect(composeCommandName("opencode", "")).toBe("opencode")
  })
})
