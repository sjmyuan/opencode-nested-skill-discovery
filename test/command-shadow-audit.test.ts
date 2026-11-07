import { describe, expect, it } from "vitest"
import type { NativeCommandNameIndex } from "../src/command-native.ts"
import { auditCommandList, type PublishedCommand } from "../src/command-shadow.ts"

const noNative: NativeCommandNameIndex = { names: [], complete: true, diagnostics: [] }

function published(name: string, description?: string): PublishedCommand {
  return { name, canonicalPath: `/repo/${name}.md`, description }
}

describe("post-reload command audit", () => {
  it("classifies a listed name that matches the published description as ours with no diagnostic", () => {
    const outcome = auditCommandList({
      listed: [{ name: "A:deploy", description: "Deploy A" }],
      published: [published("A:deploy", "Deploy A")],
      native: noNative,
    })

    expect(outcome).toEqual({ shadowed: [], absent: [], foreign: [], diagnostics: [] })
  })

  it("classifies a description mismatch as shadowed", () => {
    const outcome = auditCommandList({
      listed: [{ name: "A:deploy", description: "theirs" }],
      published: [published("A:deploy", "ours")],
      native: noNative,
    })

    expect(outcome.shadowed).toEqual(["A:deploy"])
    expect(outcome.absent).toEqual([])
    expect(outcome.foreign).toEqual([])
    expect(outcome.diagnostics).toEqual(["native-shadow-audit: A:deploy"])
  })

  it("classifies a published name missing from the listing as absent and not shadowed", () => {
    const outcome = auditCommandList({
      listed: [],
      published: [published("A:deploy", "ours")],
      native: noNative,
    })

    expect(outcome.absent).toEqual(["A:deploy"])
    expect(outcome.shadowed).toEqual([])
    expect(outcome.diagnostics).toEqual(["command-absent: A:deploy"])
  })

  it("stays silent for a foreign name that no published entry explains", () => {
    const outcome = auditCommandList({
      listed: [{ name: "mcp:prompt", description: "someone else" }],
      published: [],
      native: noNative,
    })

    expect(outcome.foreign).toEqual(["mcp:prompt"])
    expect(outcome.shadowed).toEqual([])
    expect(outcome.absent).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it("classifies a published name without a colon prefix as ours", () => {
    const outcome = auditCommandList({
      listed: [{ name: "deploy", description: "Deploy" }],
      published: [published("deploy", "Deploy")],
      native: noNative,
    })

    expect(outcome.shadowed).toEqual([])
    expect(outcome.absent).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it("accepts an identical description as indistinguishable", () => {
    const same = auditCommandList({
      listed: [{ name: "A:deploy", description: "shared" }],
      published: [published("A:deploy", "shared")],
      native: noNative,
    })
    const undefinedPair = auditCommandList({
      listed: [{ name: "A:deploy" }],
      published: [published("A:deploy")],
      native: noNative,
    })

    expect(same.diagnostics).toEqual([])
    expect(undefinedPair.diagnostics).toEqual([])
    expect(undefinedPair.shadowed).toEqual([])
  })

  it("never reports a foreign native or built-in name as shadowed", () => {
    const native: NativeCommandNameIndex = {
      names: ["deploy", "review/pr"],
      complete: true,
      diagnostics: [],
    }

    const outcome = auditCommandList({
      listed: [{ name: "deploy" }, { name: "help" }, { name: "review/pr" }],
      published: [],
      native,
    })

    expect(outcome.shadowed).toEqual([])
    expect(outcome.diagnostics).toEqual([])
    expect(outcome.foreign).toEqual(["deploy", "help", "review/pr"])
  })
})
