import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ACCEPTED_RISK, GUIDANCE } from "../src/placement.ts"

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

describe("placement gate: the accepted-risk wording", () => {
  it("appears once and identically on the tool description, the README and the limits", () => {
    expect(GUIDANCE).toContain(ACCEPTED_RISK)
    expect(occurrences(read("README.md"), ACCEPTED_RISK)).toBe(1)
    expect(occurrences(read("docs/limits.md"), ACCEPTED_RISK)).toBe(1)
  })

  it("names the four gaps the decision records", () => {
    const passage = normalise(ACCEPTED_RISK)

    for (const gap of ["never indexed", "native IDs", "permission configuration", "opencode_session_move"]) {
      expect(passage).toContain(gap)
    }
    expect(passage).toContain("not a policy boundary")
  })

  it("never claims a security boundary", () => {
    expect(GUIDANCE).not.toMatch(/security boundary/)
    expect(section(read("README.md"), "## Subagent placement")).not.toMatch(/security boundary/)

    const limits = section(read("docs/limits.md"), "## Placement")
    expect(limits.match(/security boundary/g) ?? []).toHaveLength(1)
    expect(limits).toContain("not a security boundary")
  })

  it("points at the gate from the permission and architecture docs", () => {
    expect(read("docs/permissions.md")).toContain("placement")
    expect(read("docs/architecture.md")).toContain("pre-placement")
  })
})
