import { describe, expect, it } from "vitest"
import { ID_PREFIX, MAX_ID_LENGTH, MAX_SCOPE_SLUG_LENGTH, MAX_SKILL_SLUG_LENGTH } from "../src/contracts.ts"
import { nativeIdFor, scopeTokenFor, skillTokenFor, slug } from "../src/indexer.ts"

const idOf = (scopeToken: string, skillToken: string): string => `${ID_PREFIX}${scopeToken}.${skillToken}`

describe("native id derivation", () => {
  it("names SKILL.md after its parent directory", () => {
    expect(nativeIdFor("/work/ws/a/.opencode/skills/deploy/SKILL.md")).toBe("deploy")
  })

  it("names a root markdown file after its stem", () => {
    expect(nativeIdFor("/work/ws/a/.opencode/skills/review.md")).toBe("review")
  })

  it("uses the skill directory, never the root directory", () => {
    expect(nativeIdFor("/work/ws/a/.opencode/skills/x/SKILL.md")).toBe("x")
  })
})

describe("nested id derivation", () => {
  it("pins the SKILL.md id from the ADR example", () => {
    const file = "/work/ws/a/.opencode/skills/deploy/SKILL.md"
    const scopeToken = scopeTokenFor("/work/ws/a")
    const skillToken = skillTokenFor(nativeIdFor(file), file)

    expect(scopeToken).toBe("a-4942297c")
    expect(skillToken).toBe("deploy-0025f628")
    expect(idOf(scopeToken, skillToken)).toBe("nested.a-4942297c.deploy-0025f628")
  })

  it("pins the root markdown id", () => {
    const file = "/work/ws/a/.opencode/skills/review.md"

    expect(idOf(scopeTokenFor("/work/ws/a"), skillTokenFor(nativeIdFor(file), file))).toBe(
      "nested.a-4942297c.review-99253eac",
    )
  })

  it("pins the non-ASCII id", () => {
    const file = "/work/ws/ünïcode/SKILL.md"

    expect(nativeIdFor(file)).toBe("ünïcode")
    expect(idOf(scopeTokenFor("/work/ws/ünïcode"), skillTokenFor(nativeIdFor(file), file))).toBe(
      "nested.n-code-99757a86.n-code-5bc73959",
    )
  })

  it("derives the scope token of the location itself", () => {
    expect(scopeTokenFor("/work/ws")).toBe("ws-fce99486")
  })
})

describe("slug", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    expect(slug("Deploy  Release!!", MAX_SKILL_SLUG_LENGTH)).toBe("deploy-release")
    expect(slug("--a--b--", MAX_SKILL_SLUG_LENGTH)).toBe("a-b")
  })

  it("falls back to x when nothing alphanumeric remains", () => {
    expect(slug("日本語", MAX_SKILL_SLUG_LENGTH)).toBe("x")
    expect(slug("", MAX_SKILL_SLUG_LENGTH)).toBe("x")
  })

  it("caps the slug and strips a hyphen the cap exposes", () => {
    const long = "averyveryverylongtaskdirectorynamethatextendsbeyond"

    expect(slug(long, MAX_SCOPE_SLUG_LENGTH)).toHaveLength(MAX_SCOPE_SLUG_LENGTH)
    expect(slug(long, MAX_SCOPE_SLUG_LENGTH)).toBe(long.slice(0, MAX_SCOPE_SLUG_LENGTH))
    expect(slug(`${"a".repeat(39)}-b`, MAX_SKILL_SLUG_LENGTH)).toBe("a".repeat(39))
  })

  it("keeps every id segment clean, short, and wildcard-free", () => {
    const scopeToken = scopeTokenFor("/work/ws/we*ird?dir")
    const skillToken = skillTokenFor("日本語".repeat(20), "/work/ws/we*ird?dir/日本語/SKILL.md")
    const id = idOf(scopeToken, skillToken)

    expect(scopeToken).toMatch(/^[a-z0-9-]+$/)
    expect(id).toBe(`${ID_PREFIX}${scopeToken}.${skillToken}`)
    expect(id).not.toContain("*")
    expect(id).not.toContain("?")
    expect(id.length).toBeLessThanOrEqual(MAX_ID_LENGTH)
    expect(skillToken.startsWith("x-")).toBe(true)
  })

  it("pins the empty-slug scope token", () => {
    expect(scopeTokenFor("/work/ws/日本語")).toBe("x-4453d510")
  })
})
