import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO = fileURLToPath(new URL("..", import.meta.url))

/** This machine's checkout of `opencode-v2.0.26`; `OPENCODE_PIN` is the only override. */
const PIN = process.env.OPENCODE_PIN ?? "/Users/ganggang/work/opencode-v2.0.26"
const pinAvailable = existsSync(PIN)

/** The repo has no top-level `packages/`, so this prefix resolves only at the pin. */
const EXTERNAL_PREFIX = "packages/"

/** Measured at the F13 rework head; re-measure both whenever a doc gains or loses a citation. */
const EXPECTED_IN_REPO = 203
const EXPECTED_EXTERNAL = 55

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

type Kind = "in-repo" | "external" | "missing"

type Resolution =
  | { readonly kind: "in-repo" | "external"; readonly file: string }
  | { readonly kind: "external-unavailable" }
  | { readonly kind: "missing" }

const kindOf = (target: string): Kind => {
  if (existsSync(path.join(REPO, target))) return "in-repo"
  return target.startsWith(EXTERNAL_PREFIX) ? "external" : "missing"
}

const resolve = (target: string): Resolution => {
  const kind = kindOf(target)
  if (kind === "missing") return { kind }
  if (kind === "in-repo") return { kind, file: path.join(REPO, target) }
  if (!pinAvailable) return { kind: "external-unavailable" }
  const pinned = path.join(PIN, target)
  return existsSync(pinned) ? { kind, file: pinned } : { kind: "missing" }
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

const checkBounds = (citation: Citation, file: string, problems: string[]): void => {
  const total = linesOf(file).length
  for (const [start, end] of parts(citation.ranges)) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) {
      problems.push(`${citation.doc}:${citation.line} ${citation.target}:${start}-${end} of ${total}`)
    }
  }
}

const slice = (target: string, start: number, end: number): string => {
  const resolved = resolve(target)
  return "file" in resolved ? linesOf(resolved.file).slice(start - 1, end).join("\n") : ""
}

describe("docs citations: bounds", () => {
  it("every in-repo citation resolves to a range inside its file", () => {
    const problems: string[] = []
    for (const citation of citations()) {
      const resolved = resolve(citation.target)
      if (resolved.kind === "external-unavailable") continue
      if (resolved.kind === "missing") {
        problems.push(`${citation.doc}:${citation.line} missing ${citation.target}`)
        continue
      }
      checkBounds(citation, resolved.file, problems)
    }
    expect(problems).toEqual([])
  })

  it.skipIf(!pinAvailable)("every pinned citation resolves to a range inside its file", () => {
    const problems: string[] = []
    for (const citation of citations().filter((citation) => kindOf(citation.target) === "external")) {
      const file = path.join(PIN, citation.target)
      if (!existsSync(file)) {
        problems.push(`${citation.doc}:${citation.line} missing ${citation.target}`)
        continue
      }
      checkBounds(citation, file, problems)
    }
    expect(problems).toEqual([])
  })

  it("keeps the citation totals pinned", () => {
    const kinds = citations().map((citation) => kindOf(citation.target))
    expect(kinds.filter((kind) => kind === "in-repo")).toHaveLength(EXPECTED_IN_REPO)
    expect(kinds.filter((kind) => kind === "external")).toHaveLength(EXPECTED_EXTERNAL)
    expect(kinds.filter((kind) => kind === "missing")).toHaveLength(0)
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
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "485-738", marker: "const runRefresh = async" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "86-91", marker: "function capDiagnostics" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "95-106", marker: "async function runStage" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "196-205", marker: "export interface RefreshOutcome" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "646-662", marker: 'runStage(diagnostics, "command-audit"' },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "39", marker: "DEDUPE_DEFERRED_DELAYS_MS = [1500, 4000]" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "859", marker: "dedupe-deferred: ${reasonOf(error)}" },
  { doc: "docs/architecture.md", target: "src/registry.ts", ranges: "664-665", marker: 'runStage(diagnostics, "reload", () => ctx.skill.reload())' },
  { doc: "docs/architecture.md", target: "src/command-audit.ts", ranges: "5-10", marker: "EMPTY_NATIVE_COMMANDS" },
  { doc: "README.md", target: "src/command-execute.ts", ranges: "30-104", marker: "export function createCommandExecutor" },
  { doc: "docs/limits.md", target: "src/command-model.ts", ranges: "58-64", marker: "export function canonicalModelSelection" },
  { doc: "docs/architecture.md", target: "src/contracts.ts", ranges: "205-207", marker: "commandVersion: (locationToken: string): string =>" },
  { doc: "README.md", target: "src/command-expand.ts", ranges: "56-150", marker: "export async function expandCommand" },
  { doc: "README.md", target: "src/command-expand.ts", ranges: "56-150", marker: "return { text: expanded, diagnostics, shellFailed: diagnostics.length > 0 }" },
  { doc: "docs/architecture.md", target: "src/indexer.ts", ranges: "48-50", marker: "export function scopeTokenFor" },
  { doc: "docs/architecture.md", target: "src/indexer.ts", ranges: "62-64", marker: "export function skillTokenFor" },
  { doc: "docs/architecture.md", target: "src/indexer.ts", ranges: "42-46", marker: "export function nativeIdFor" },
  { doc: "docs/limits.md", target: "src/indexer.ts", ranges: "194-198", marker: "const toIndexedSkill" },
  { doc: "docs/architecture.md", target: "src/indexer.ts", ranges: "254-256", marker: "const deduped = dedupeByNativeId" },
  { doc: "docs/limits.md", target: "src/indexer.ts", ranges: "48-50", marker: "export function scopeTokenFor" },
  { doc: "docs/limits.md", target: "src/indexer.ts", ranges: "62-64", marker: "export function skillTokenFor" },
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
