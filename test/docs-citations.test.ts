import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const PIN = "/Users/ganggang/work/opencode-v2.0.26"
const DOCS = [
  "README.md",
  "docs/architecture.md",
  "docs/limits.md",
  "docs/installation.md",
  "docs/permissions.md",
  "docs/design.md",
] as const

const CITATION = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|md|json|jsonc|mdx)):([0-9][0-9,-]*)`/g

interface Citation {
  readonly doc: string
  readonly line: number
  readonly target: string
  readonly ranges: string
}

const fileOf = (target: string): string | undefined => {
  const local = path.join(REPO, target)
  if (existsSync(local)) return local
  const pinned = path.join(PIN, target)
  return existsSync(pinned) ? pinned : undefined
}

const linesOf = (file: string): readonly string[] => readFileSync(file, "utf8").split("\n")

const citations = (): readonly Citation[] =>
  DOCS.flatMap((doc) =>
    linesOf(path.join(REPO, doc)).flatMap((text, index) =>
      [...text.matchAll(CITATION)].map((match) => ({
        doc,
        line: index + 1,
        target: String(match[1]),
        ranges: String(match[2]),
      })),
    ),
  )

const parts = (ranges: string): ReadonlyArray<readonly [number, number]> =>
  ranges.split(",").map((part) => {
    const [rawStart, rawEnd] = part.split("-")
    const start = Number(rawStart ?? 0)
    const end = rawEnd === undefined ? start : Number(rawEnd)
    return [start, end] as const
  })

const slice = (target: string, start: number, end: number): string => {
  const file = fileOf(target)
  return file === undefined ? "" : linesOf(file).slice(start - 1, end).join("\n")
}

describe("docs citations: bounds", () => {
  it("every in-repo citation resolves to a range inside its file", () => {
    const problems: string[] = []
    for (const citation of citations()) {
      const file = fileOf(citation.target)
      if (file === undefined) {
        problems.push(`${citation.doc}:${citation.line} missing ${citation.target}`)
        continue
      }
      const total = linesOf(file).length
      for (const [start, end] of parts(citation.ranges)) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) {
          problems.push(`${citation.doc}:${citation.line} ${citation.target}:${start}-${end} of ${total}`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})

/**
 * The load-bearing claims: a one-line shift of any range drops its marker, so the map
 * pins the anchor rather than only its bounds (PD8).
 */
const ANCHORS: ReadonlyArray<{
  readonly doc: (typeof DOCS)[number]
  readonly target: string
  readonly ranges: string
  readonly marker: string
}> = [
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "467-719", marker: "const runRefresh = async" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "85-90", marker: "function capDiagnostics" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "94-105", marker: "async function runStage" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "195-204", marker: "export interface RefreshOutcome" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "627-643", marker: 'runStage(diagnostics, "command-audit"' },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "38", marker: "DEDUPE_DEFERRED_DELAYS_MS = [1500, 4000]" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "840", marker: "dedupe-deferred: ${reasonOf(error)}" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "645-646", marker: 'runStage(diagnostics, "reload", () => ctx.skill.reload())' },
  { doc: "docs/architecture.md", target: "src/command-audit.ts", ranges: "5-10", marker: "EMPTY_NATIVE_COMMANDS" },
  { doc: "README.md", target: "src/command-execute.ts", ranges: "30-104", marker: "export function createCommandExecutor" },
  { doc: "docs/limits.md", target: "src/command-model.ts", ranges: "58-64", marker: "export function canonicalModelSelection" },
  { doc: "docs/architecture.md", target: "src/contracts.ts", ranges: "205-207", marker: 'commandVersion: "nested/commands/version"' },
]

describe("docs citations: curated anchors", () => {
  it.each(ANCHORS.map((anchor) => ({ ...anchor, cite: `\`${anchor.target}:${anchor.ranges}\`` })))(
    "$doc cites $target:$ranges",
    (anchor) => {
      expect(linesOf(path.join(REPO, anchor.doc)).join("\n")).toContain(anchor.cite)
      const [start, end] = parts(anchor.ranges)[0] ?? [0, 0]
      expect(slice(anchor.target, start, end)).toContain(anchor.marker)
    },
  )
})
