import { describe, expect, it } from "vitest"
import { parseCommandFrontmatter, parseSkillFrontmatter } from "../src/frontmatter.ts"

const doc = (frontmatter: string, body = "# Deploy\n\nDeploy body.\n"): string =>
  `---\n${frontmatter}\n---\n${body}`

describe("command frontmatter", () => {
  it("F1: parses description, agent, model and subagent from the fence", () => {
    const result = parseCommandFrontmatter(
      doc(
        'description: "Deploys releases"\nagent: build\nmodel: "anthropic/claude-sonnet"\nsubagent: true',
      ),
      "deploy.md",
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({
      description: "Deploys releases",
      agent: "build",
      model: "anthropic/claude-sonnet",
      subagent: true,
    })
  })

  it("F2: a file with no fence is a template with no metadata", () => {
    const text = "# Deploy\n\nNo frontmatter here.\n"

    const result = parseCommandFrontmatter(text, "deploy.md")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({})
    expect(result.template).toBe(text)
  })

  it("F3: the body after the closing fence is the template, verbatim", () => {
    const body = "\n# Deploy\n\n\nDeploys releases.\n\n## Details\n  indented\n"

    const result = parseCommandFrontmatter(doc("description: Deploys", body), "deploy.md")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.template).toBe(body)
  })

  it("F4: an unterminated fence drops the file", () => {
    const result = parseCommandFrontmatter("---\ndescription: Deploys\n# Deploy\n", "deploy.md")

    expect(result).toEqual({ ok: false, reason: "unterminated fence" })
  })

  it("F5: a nested mapping under model drops the file with one diagnostic", () => {
    const result = parseCommandFrontmatter(
      doc("model:\n  providerID: anthropic\n  model: claude-sonnet\nagent: build"),
      "deploy.md",
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("model")
  })

  it("F6: an unsupported collection value on an accepted key drops the file", () => {
    const dropped = parseCommandFrontmatter(doc("description: [a, b]"), "deploy.md")
    const ignored = parseCommandFrontmatter(doc("tags: [a, b]"), "deploy.md")

    expect(dropped.ok).toBe(false)
    if (!dropped.ok) expect(dropped.reason).toContain("description")
    expect(ignored.ok).toBe(true)
    if (ignored.ok) {
      expect(ignored.frontmatter).toEqual({})
      expect(ignored.diagnostics).toEqual([])
    }
  })

  it("F7: description accepts a block scalar", () => {
    const result = parseCommandFrontmatter(doc("description: |\n  Deploys releases.\n  Then notifies."), "deploy.md")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter.description).toBe("Deploys releases.\nThen notifies.")
  })

  it("F8: subtask is the deprecated alias of subagent", () => {
    const aliased = parseCommandFrontmatter(doc("subtask: true"), "deploy.md")
    const explicit = parseCommandFrontmatter(doc("subtask: true\nsubagent: false"), "deploy.md")

    expect(aliased.ok).toBe(true)
    if (aliased.ok) expect(aliased.frontmatter.subagent).toBe(true)
    expect(explicit.ok).toBe(true)
    if (explicit.ok) expect(explicit.frontmatter.subagent).toBe(false)
  })

  it("F9: the skill parser ignores command keys", () => {
    const result = parseSkillFrontmatter(
      doc("description: Deploys\nagent: build\nmodel: anthropic/claude\nsubagent: true"),
      "deploy.md",
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({ description: "Deploys" })
  })

  it("F10: an unknown key's nested mapping is ignored, as the native schema ignores it", () => {
    const result = parseCommandFrontmatter(doc("metadata:\n  x: y\ndescription: Deploys"), "deploy.md")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frontmatter).toEqual({ description: "Deploys" })
    expect(result.diagnostics).toEqual([])
  })

  // Anti-regression lock: passes before and after the F10 fix, pinning the known-key edge.
  it("F11: a nested mapping under a known key still drops the file", () => {
    for (const key of ["description", "agent", "subagent"]) {
      const result = parseCommandFrontmatter(doc(`${key}:\n  x: y`), "deploy.md")

      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe(`nested mapping under ${key}`)
    }
  })

  // Anti-regression lock: the unknown-key rule must not swallow a parentless indented line.
  it("F12: an indented first frontmatter line is still unparsable", () => {
    const result = parseCommandFrontmatter(doc("  name: deploy"), "deploy.md")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("unparsable line 2: name: deploy")
  })
})
