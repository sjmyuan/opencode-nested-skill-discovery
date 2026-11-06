import { describe, expect, it } from "vitest"
import { parseSkillFrontmatter } from "../src/frontmatter.ts"

const FILE = "/work/ws/a/.opencode/skills/deploy/SKILL.md"

const parse = (lines: readonly string[], body = "# Deploy\n\nDeploys releases.\n") =>
  parseSkillFrontmatter(`---\n${lines.join("\n")}\n---\n${body}`, FILE)

describe("supported frontmatter", () => {
  it("reads name, description, and disable-model-invocation", () => {
    const result = parse(["name: deploy", "description: Deploys releases", "disable-model-invocation: true"])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({
      name: "deploy",
      description: "Deploys releases",
      disableModelInvocation: true,
    })
    expect(result.diagnostics).toEqual([])
    expect(result.body).toBe("# Deploy\n\nDeploys releases.\n")
  })

  it("unquotes quoted scalars", () => {
    const result = parse([`description: "A quoted: value"`, `name: 'quoted-name'`])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({ name: "quoted-name", description: "A quoted: value" })
  })

  it("keeps block scalars as newline-joined text", () => {
    const literal = parse(["description: |", "  line one", "  line two"])
    const folded = parse(["description: >", "  line one", "  line two"])

    expect(literal.ok).toBe(true)
    expect(folded.ok).toBe(true)
    if (!literal.ok || !folded.ok) return
    expect(literal.frontmatter.description).toBe("line one\nline two")
    expect(folded.frontmatter.description).toBe("line one line two")
  })

  it("reads autoinvoke from metadata keys", () => {
    const result = parse(["metadata:", "  opencode/autoinvoke: yes", "  other: 1"])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({ autoinvoke: true })
  })

  it("ignores unrelated metadata keys", () => {
    const result = parse(["name: deploy", "metadata:", "  owner: platform"])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({ name: "deploy" })
  })
})

describe("autoinvoke coercion", () => {
  const forms: ReadonlyArray<readonly [readonly string[], boolean | undefined]> = [
    [["name: deploy", "metadata:", "  opencode/autoinvoke: true"], true],
    [["name: deploy", "metadata:", "  opencode/autoinvoke: \"false\""], false],
    [["name: deploy", "metadata:", "  opencode/autoinvoke: 1"], true],
    [["name: deploy", "metadata:", "  opencode/autoinvoke: 0"], false],
    [["name: deploy"], undefined],
  ]

  for (const [lines, expected] of forms) {
    it(`maps ${lines.join(" ")} to ${String(expected)}`, () => {
      const result = parse(lines)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.frontmatter.name).toBe("deploy")
      expect(result.frontmatter.autoinvoke).toBe(expected)
    })
  }

  it("reads disable-model-invocation through the same coercion", () => {
    const result = parse([`disable-model-invocation: "no"`])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter.disableModelInvocation).toBe(false)
  })
})

describe("missing and malformed frontmatter", () => {
  it("indexes a file with no frontmatter and keeps the whole body", () => {
    const text = "# Title\n\nBody text.\n"
    const result = parseSkillFrontmatter(text, FILE)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe(text)
    expect(result.diagnostics).toEqual([])
  })

  it("rejects an unterminated fence", () => {
    const result = parseSkillFrontmatter("---\nname: deploy\n", FILE)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("unterminated")
  })

  it("rejects a line that is not a key-value pair", () => {
    const result = parse(["name: deploy", "greeting hello"])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("greeting hello")
  })
})

describe("unsupported frontmatter", () => {
  it("reports a flow mapping and drops the field", () => {
    const result = parse(["metadata: { opencode/autoinvoke: true }"])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({})
    expect(result.diagnostics).toEqual([`unsupported frontmatter: ${FILE}: metadata`])
  })

  it("reports an anchored scalar and drops the field", () => {
    const result = parse(["description: &summary Deploys releases"])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter.description).toBeUndefined()
    expect(result.diagnostics).toEqual([`unsupported frontmatter: ${FILE}: description`])
  })
})
