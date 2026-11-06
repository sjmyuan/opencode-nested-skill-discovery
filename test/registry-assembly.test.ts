import { describe, expect, it } from "vitest"
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from "../src/contracts.ts"
import { assembleEntries } from "../src/registry.ts"
import { indexedSkill } from "./support/registry-fixtures.ts"

describe("entry assembly", () => {
  it("qualifies the display name with the subproject path", () => {
    const [entry] = assembleEntries([indexedSkill({ subproject: "A/A.1", nativeName: "deploy" })])

    expect(entry?.name).toBe("A/A.1/deploy")
  })

  it("leaves a location-level skill unqualified", () => {
    const [entry] = assembleEntries([indexedSkill({ subproject: "", nativeName: "deploy" })])

    expect(entry?.name).toBe("deploy")
  })

  it("caps a long name and keeps the leading ellipsis", () => {
    const [entry] = assembleEntries([
      indexedSkill({ subproject: "A/A.1", nativeName: "n".repeat(120) }),
    ])

    expect(Array.from(entry?.name ?? "")).toHaveLength(MAX_NAME_LENGTH)
    expect(entry?.name.startsWith("…/")).toBe(true)
  })

  it("strips markup and caps a long description", () => {
    const [entry] = assembleEntries([
      indexedSkill({ description: `<b>"x"&</b>  ${"y".repeat(600)}` }),
    ])
    const description = entry?.description ?? ""

    expect(description).not.toMatch(/[<>"&]/)
    expect(Array.from(description).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    expect(description).not.toContain("  ")
  })

  it("carries autoinvoke only when it is defined", () => {
    const entries = assembleEntries([
      indexedSkill({ id: "nested.scope.a", autoinvoke: false }),
      indexedSkill({ id: "nested.scope.b", autoinvoke: true }),
      indexedSkill({ id: "nested.scope.c", autoinvoke: undefined }),
    ])
    const [first, second, third] = entries

    expect(first?.autoinvoke).toBe(false)
    expect(second?.autoinvoke).toBe(true)
    expect(third === undefined ? true : "autoinvoke" in third).toBe(false)
  })

  it("preserves the canonical path and the body byte for byte", () => {
    const body = "---\nname: deploy\n---\n# Deploy\n\n  indented\n"
    const [entry] = assembleEntries([
      indexedSkill({ canonicalPath: "/private/tmp/skill/SKILL.md", content: body }),
    ])

    expect(entry?.canonicalPath).toBe("/private/tmp/skill/SKILL.md")
    expect(entry?.content).toBe(body)
  })

  it("sorts entries ascending by id", () => {
    const entries = assembleEntries([
      indexedSkill({ id: "nested.scope.d" }),
      indexedSkill({ id: "nested.scope.b" }),
      indexedSkill({ id: "nested.scope.e" }),
      indexedSkill({ id: "nested.scope.a" }),
      indexedSkill({ id: "nested.scope.c" }),
    ])

    expect(entries.map((entry) => entry.id)).toEqual([
      "nested.scope.a",
      "nested.scope.b",
      "nested.scope.c",
      "nested.scope.d",
      "nested.scope.e",
    ])
  })

  it("returns an empty list for no skills", () => {
    expect(assembleEntries([])).toEqual([])
  })
})
