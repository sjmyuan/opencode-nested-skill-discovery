import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ACCEPTED_RISK, GUIDANCE, extendInput } from "../src/placement.ts"

const REPO = fileURLToPath(new URL("..", import.meta.url))

const read = (relative: string): string => readFileSync(path.join(REPO, relative), "utf8")

const normalise = (text: string): string => text.replace(/\s+/g, " ").trim()

const occurrences = (text: string, needle: string): number =>
  normalise(text).split(normalise(needle)).length - 1

const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading)
  if (start < 0) return ""
  const rest = text.slice(start + heading.length)
  const end = rest.indexOf("\n## ")
  return end < 0 ? rest : rest.slice(0, end)
}

const DOCS = [
  "README.md",
  "docs/architecture.md",
  "docs/design.md",
  "docs/installation.md",
  "docs/limits.md",
  "docs/permissions.md",
]

const RESOLUTION_BASE = "the location serving the call"

const directoryDescription = (): string => {
  const schema = extendInput({ type: "object", properties: {} }) as {
    properties: Record<string, { description?: string }>
  }
  return schema.properties.directory?.description ?? ""
}

const GUIDANCE_ROWS = [
  { line: "directory optionally places", phrase: "task is admitted", docs: ["README.md", "docs/limits.md"] },
  { line: "Absolute paths are used", phrase: RESOLUTION_BASE, docs: ["README.md", "docs/limits.md"] },
  {
    line: "The destination must be inside",
    phrase: "inside this project or one of its worktrees",
    docs: ["README.md"],
  },
  { line: "A placed child narrows", phrase: "loses sibling subprojects", docs: ["docs/limits.md"] },
  { line: "With sessionID a different", phrase: "not rewritten", docs: ["docs/limits.md"] },
  { line: "A refused destination creates no child", phrase: "creates no child", docs: ["README.md"] },
  { line: "ACCEPTED_RISK", phrase: ACCEPTED_RISK, docs: ["README.md", "docs/limits.md"] },
]

describe("placement guidance: the resolution base", () => {
  it("names the location serving the call once in the guidance, the schema and both placement docs", () => {
    expect(occurrences(GUIDANCE, RESOLUTION_BASE)).toBe(1)
    expect(occurrences(directoryDescription(), RESOLUTION_BASE)).toBe(1)
    expect(occurrences(read("README.md"), RESOLUTION_BASE)).toBe(1)
    expect(occurrences(read("docs/limits.md"), RESOLUTION_BASE)).toBe(1)
  })

  it("never calls the resolution base the calling session", () => {
    expect(occurrences(GUIDANCE, "calling session")).toBe(0)
    expect(occurrences(directoryDescription(), "calling session")).toBe(0)

    for (const doc of DOCS) expect(occurrences(read(doc), "calling session"), doc).toBe(0)
  })
})

describe("placement guidance: every bullet is carried by the docs", () => {
  it.each(GUIDANCE_ROWS)("ships $line", ({ phrase, docs }) => {
    expect(occurrences(GUIDANCE, phrase)).toBeGreaterThan(0)

    for (const doc of docs) expect(normalise(read(doc)), doc).toContain(normalise(phrase))
  })

  it("has a row for every guidance line", () => {
    const lines = GUIDANCE.split("\n")

    for (const line of lines) {
      expect(GUIDANCE_ROWS.some((row) => normalise(line).includes(normalise(row.phrase))), line).toBe(true)
    }
    expect(GUIDANCE_ROWS).toHaveLength(lines.length)
  })
})

describe("placement: the accepted-risk wording", () => {
  it("appears once and identically on the tool description, the README and the limits", () => {
    expect(GUIDANCE).toContain(ACCEPTED_RISK)
    expect(occurrences(read("README.md"), ACCEPTED_RISK)).toBe(1)
    expect(occurrences(read("docs/limits.md"), ACCEPTED_RISK)).toBe(1)
  })

  it("names what the accepted risk turns on", () => {
    const passage = normalise(ACCEPTED_RISK)

    expect(passage).toContain("the move changes that location")
    expect(passage).toContain("`Skill.available` for advertisement and the `skill` assert for invocation")
    expect(passage).toContain("moves any session with no skill-permission check at all")
    expect(passage).toContain("a `nested.`-prefixed pattern does not")
  })

  it("never claims a security boundary", () => {
    expect(GUIDANCE).not.toMatch(/security boundary/)
    expect(section(read("README.md"), "## Subagent placement")).not.toMatch(/security boundary/)

    const limits = section(read("docs/limits.md"), "## Placement")
    expect(limits.match(/security boundary/g) ?? []).toHaveLength(1)
    expect(limits).toContain("not a security boundary")
  })

  it("promises no pre-move `skill` check in any placement doc", () => {
    const permissions = normalise(read("docs/permissions.md"))
    const architecture = normalise(read("docs/architecture.md"))

    for (const doc of ["README.md", "docs/limits.md", "docs/permissions.md"]) {
      expect(normalise(read(doc)), doc).toContain("runs no `skill` permission check before the move")
    }
    expect(permissions).toContain("[docs/limits.md](limits.md#placement)")

    const surfaces: Array<[string, string]> = [
      ...DOCS.map((doc) => [doc, normalise(read(doc))] as [string, string]),
      ["GUIDANCE", normalise(GUIDANCE)],
    ]

    for (const [name, text] of surfaces) {
      expect(text.split(normalise(ACCEPTED_RISK)).join(""), name).not.toContain(
        "runs no check before the move",
      )
    }

    for (const text of [permissions, architecture, normalise(GUIDANCE)]) {
      expect(text).not.toContain("refuses the placement")
      expect(text).not.toContain("pre-placement")
      expect(text).not.toContain("asserts the destination's")
    }
  })
})
