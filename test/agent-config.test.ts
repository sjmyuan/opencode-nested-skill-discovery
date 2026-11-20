import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "jsonc-parser"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import {
  readConfigDocument,
  substituteConfined,
  type SubstitutionLimits,
} from "../src/agent-config.ts"

/**
 * F16 Step 4 (ADR agent A10, A14, A15): one document in, one `ConfigDocument` or one
 * diagnostic out. JSONC parsing mirrors the pinned host (`config.ts:138-149`); `{file:}`
 * substitution diverges deliberately — confined to the marked directory's realpath, capped
 * per document, one read per token, every refusal substituting empty with one line.
 */

/** Every `readFile` the module performs, so "never opened" is a measured property. */
const reads = vi.hoisted(() => [] as string[])

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: (async (path: string, options?: unknown) => {
      reads.push(String(path))
      return (actual.readFile as unknown as (file: string, settings?: unknown) => Promise<string>)(
        path,
        options,
      )
    }) as typeof actual.readFile,
  }
})

const created: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nested-agent-config-"))
  created.push(root)
  return root
}

async function write(root: string, rel: string, content = ""): Promise<string> {
  const path = join(root, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

beforeEach(() => {
  reads.length = 0
})

afterEach(async () => {
  delete process.env.F16_DESC
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function document(text: string, rel = "A/opencode.json"): Promise<string> {
  return write(await workspace(), rel, text)
}

interface ReadOptions {
  /** The marked directory `d` of A10; defaults to the document's own directory. */
  readonly marked?: string
  readonly display?: string
  readonly home?: string
  readonly limits?: SubstitutionLimits
}

const read = async (path: string, options: ReadOptions = {}) =>
  readConfigDocument({
    path,
    canonicalPath: path,
    rootRealPath: options.marked ?? dirname(path),
    home: options.home ?? "/home/test",
    display: options.display ?? "A/opencode.json",
    limits: options.limits ?? DEFAULT_SCAN_LIMITS,
  })

const source = (path: string, rootRealPath = dirname(path), home = "/home/test") => ({
  path,
  rootRealPath,
  home,
  display: "A/opencode.json",
  limits: DEFAULT_SCAN_LIMITS,
})

const countOfReads = (path: string): number => reads.filter((entry) => entry === path).length

describe("variable substitution", () => {
  it("substitutes {env:VAR} raw", async () => {
    process.env.F16_DESC = "plain"
    const path = await document(`{"agents":{"a":{"description":"{env:F16_DESC}"}}}`)

    const result = await read(path)

    expect(result.diagnostics).toEqual([])
    expect(result.document?.agents.get("a")?.description).toBe("plain")
  })

  it("retries with an escaped value when the raw pass breaks the JSON", async () => {
    process.env.F16_DESC = 'a"b\\c'
    const text = `{"agents":{"a":{"description":"{env:F16_DESC}"}}}`
    const path = await document(text)

    const raw = text.replace("{env:F16_DESC}", process.env.F16_DESC)
    const rawErrors: unknown[] = []
    parse(raw, rawErrors as never, { allowTrailingComma: true })
    expect(rawErrors.length).toBeGreaterThan(0)

    const substituted = await substituteConfined(text, source(path))
    const errors: unknown[] = []
    parse(substituted.text, errors as never, { allowTrailingComma: true })
    expect(errors).toEqual([])
    expect(substituted.text).not.toBe(raw)
    expect((await read(path)).document?.agents.get("a")?.description).toBe('a"b\\c')
  })

  it("inlines a {file:} reference relative to the document, trimmed", async () => {
    const path = await document(`{"agents":{"a":{"description":"{file:./prompt.md}"}}}`, "A/opencode.json")
    await writeFile(join(path, "..", "prompt.md"), "  body text\n")

    const result = await read(path)

    expect(result.diagnostics).toEqual([])
    expect(result.document?.agents.get("a")?.description).toBe("body text")
  })

  it("substitutes empty for a missing {file:} with one line, and leaves a commented token verbatim", async () => {
    const path = await document(
      `{\n// {file:./missing.md}\n"agents":{"a":{"description":"{file:./missing.md}"}}}`,
    )

    const result = await read(path)

    // D8: a missing target is refused, not silently empty — and it is never read.
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:./missing.md} outside-root",
    ])
    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(countOfReads(join(path, "..", "missing.md"))).toBe(0)
    const text = await readFile(path, "utf8")
    expect((await substituteConfined(text, source(path))).text).toContain("// {file:./missing.md}")
  })
})

describe("A10 confinement", () => {
  it("refuses a ../.. escape without a filesystem call", async () => {
    const root = await workspace()
    const path = await write(root, "A/opencode.json", `{"agents":{"a":{"description":"{file:../../secret.md}"}}}`)
    const result = await read(path, { marked: join(root, "A") })

    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:../../secret.md} outside-root",
    ])
    // The document is the only read: the refused token cost no filesystem call at all.
    expect(reads).toEqual([path])
  })

  it("refuses an absolute reference without a filesystem call", async () => {
    const path = await document(`{"agents":{"a":{"description":"{file:/etc/hosts}"}}}`)

    const result = await read(path)

    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:/etc/hosts} outside-root",
    ])
    expect(reads).toEqual([path])
  })

  it("refuses a ~-leading reference even when a home is supplied", async () => {
    const home = await workspace()
    await writeFile(join(home, "snippet.md"), "home text\n")
    const path = await document(`{"agents":{"a":{"description":"{file:~/snippet.md}"}}}`)

    const result = await read(path, { home })

    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:~/snippet.md} outside-root",
    ])
    expect(countOfReads(join(home, "snippet.md"))).toBe(0)
  })

  it("refuses a symlink whose realpath leaves the marked directory", async () => {
    const root = await workspace()
    await write(root, "outside/x.md", "outside text\n")
    const path = await write(root, "A/opencode.json", `{"agents":{"a":{"description":"{file:./link.md}"}}}`)
    await symlink(join(root, "outside", "x.md"), join(root, "A/link.md"))

    const result = await read(path, { marked: join(root, "A") })

    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:./link.md} outside-root",
    ])
    expect(countOfReads(await realpath(join(root, "outside", "x.md")))).toBe(0)
  })

  it("substitutes an inward symlink to a regular file inside the marked directory", async () => {
    const root = await workspace()
    const path = await write(root, "A/opencode.json", `{"agents":{"a":{"description":"{file:./inlink.md}"}}}`)
    const real = await write(root, "A/real.md", "  inner text \n")
    await symlink("real.md", join(root, "A/inlink.md"))

    const result = await read(path, { marked: join(root, "A") })

    expect(result.diagnostics).toEqual([])
    expect(result.document?.agents.get("a")?.description).toBe("inner text")
    expect(countOfReads(await realpath(real))).toBe(1)
  })

  it("refuses a broken link", async () => {
    const root = await workspace()
    const path = await write(root, "A/opencode.json", `{"agents":{"a":{"description":"{file:./broken.md}"}}}`)
    await symlink("./gone.md", join(root, "A/broken.md"))

    const result = await read(path, { marked: join(root, "A") })

    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:./broken.md} outside-root",
    ])
    expect(countOfReads(join(root, "A/gone.md"))).toBe(0)
  })

  it("refuses a non-regular target without reading it", async () => {
    const root = await workspace()
    const path = await write(root, "A/opencode.json", `{"agents":{"a":{"description":"{file:./dir}"}}}`)
    await mkdir(join(root, "A/dir"), { recursive: true })

    const result = await read(path, { marked: join(root, "A") })

    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:./dir} outside-root",
    ])
    expect(reads).toEqual([path])
  })

  it("refuses an intermediate directory symlink that stat follows", async () => {
    const root = await workspace()
    await write(root, "outside/x.md", "outside text\n")
    const path = await write(root, "A/opencode.json", `{"agents":{"a":{"description":"{file:./dir/x.md}"}}}`)
    await symlink(join(root, "outside"), join(root, "A/dir"))

    const result = await read(path, { marked: join(root, "A") })

    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:./dir/x.md} outside-root",
    ])
    expect(countOfReads(await realpath(join(root, "outside", "x.md")))).toBe(0)
  })

  it("allows a .. reference whose target stays inside the marked directory", async () => {
    const root = await workspace()
    const path = await write(
      root,
      "A/.opencode/opencode.jsonc",
      `{"agents":{"a":{"description":"{file:../shared.md}"}}}`,
    )
    await write(root, "A/shared.md", " shared body\n")

    const result = await read(path, { marked: join(root, "A"), display: "A/.opencode/opencode.jsonc" })

    expect(result.diagnostics).toEqual([])
    expect(result.document?.agents.get("a")?.description).toBe("shared body")
  })

  it("refuses a 40 MB target by the per-file cap without reading it", async () => {
    const root = await workspace()
    const path = await write(root, "A/opencode.json", `{"agents":{"a":{"description":"{file:./big.md}"}}}`)
    const big = await write(root, "A/big.md")
    await truncate(big, 40 * 1024 * 1024)
    const before = process.memoryUsage().rss

    const result = await read(path, { marked: join(root, "A") })
    const delta = process.memoryUsage().rss - before

    expect(result.document?.agents.get("a")?.description).toBe("")
    expect(result.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:./big.md} cap-file",
    ])
    expect(countOfReads(await realpath(big))).toBe(0)
    // Observation only — "never opened" above is the deterministic property.
    expect(delta).toBeLessThan(1024 * 1024 * 1024)
  })

  it("caps the running total per document and not across documents", async () => {
    const root = await workspace()
    const limits: SubstitutionLimits = { maxFileBytes: 100_000, maxTotalBytes: 120_000 }
    const path = await write(
      root,
      "A/opencode.json",
      `{"agents":{"a":{"description":"{file:./one.md}{file:./two.md}"}}}`,
    )
    await write(root, "A/one.md", "a".repeat(80_000))
    await write(root, "A/two.md", "b".repeat(80_000))

    const both = await read(path, { marked: join(root, "A"), limits })

    expect(both.document?.agents.get("a")?.description).toBe("a".repeat(80_000))
    expect(both.diagnostics).toEqual([
      "agent-skip: A/opencode.json: file-ref {file:./two.md} cap-total",
    ])

    // The ledger is per document: the same 80 KB in another document is not capped.
    const second = await write(root, "A/opencode.jsonc", `{"agents":{"b":{"description":"{file:./two.md}"}}}`)
    const other = await read(second, { marked: join(root, "A"), display: "A/opencode.jsonc", limits })

    expect(other.diagnostics).toEqual([])
    expect(other.document?.agents.get("b")?.description).toBe("b".repeat(80_000))
  })

  it("reads the document and a referenced target once across the escaped retry", async () => {
    process.env.F16_DESC = 'a"b\\c'
    const root = await workspace()
    const path = await write(
      root,
      "A/opencode.json",
      `{"agents":{"a":{"description":"{env:F16_DESC} {file:./prompt.md}"}}}`,
    )
    const target = await write(root, "A/prompt.md", " prompt body\n")

    const result = await read(path, { marked: join(root, "A") })

    expect(result.document?.agents.get("a")?.description).toBe('a"b\\c prompt body')
    expect(countOfReads(await realpath(target))).toBe(1)
    expect(countOfReads(path)).toBe(1)
  })
})

describe("JSONC and the read set", () => {
  it("parses comments and trailing commas", async () => {
    const path = await document(
      `{\n  // a comment\n  "agents": { "a": { "description": "d", }, },\n}`,
    )

    const result = await read(path)

    expect(result.diagnostics).toEqual([])
    expect(result.document?.agents.get("a")?.description).toBe("d")
  })

  it("reads agents, top-level permissions and default_agent only", async () => {
    const path = await document(
      JSON.stringify({
        agents: {
          a: {
            description: "d",
            permissions: [{ action: "read", resource: "**", effect: "allow" }],
          },
        },
        permissions: [{ action: "bash", resource: "*", effect: "ask" }],
        default_agent: "build",
        mcp: { x: 1 },
        zzz: 42,
      }),
    )

    const result = await read(path)

    expect(result.diagnostics).toEqual(["agent-default-ignored: A/opencode.json"])
    expect(result.document?.agents.get("a")?.permissions).toEqual([
      { action: "read", resource: "**", effect: "allow" },
    ])
    expect(result.document?.permissions).toEqual([{ action: "bash", resource: "*", effect: "ask" }])
    expect(result.document?.defaultAgent).toBe("build")
  })

  it("keeps { system } alone decodable", async () => {
    const path = await document(`{"agents":{"a":{"system":"you are a translator"}}}`)

    const result = await read(path)

    expect(result.diagnostics).toEqual([])
    expect(result.document?.agents.get("a")?.system).toBe("you are a translator")
  })

  it("leaves default_agent absent without a diagnostic when unset", async () => {
    const path = await document(`{"agents":{"a":{"description":"d"}}}`)

    const result = await read(path)

    expect(result.diagnostics).toEqual([])
    expect(result.document?.defaultAgent).toBeUndefined()
  })

  it("returns an empty document for {} and for a document with no agents", async () => {
    for (const text of ["{}", `{"permissions":[]}`]) {
      const path = await document(text)
      const result = await read(path)

      expect(result.diagnostics).toEqual([])
      expect(result.document?.agents.size).toBe(0)
      expect(result.document?.permissions).toEqual([])
    }
  })
})

describe("drops", () => {
  it("reports one malformed diagnostic and no document", async () => {
    const path = await document(`{"agents": {`)

    const result = await read(path)

    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toEqual(["agent-skip: malformed A/opencode.json"])
  })

  it("drops the whole document when one entry is invalid", async () => {
    const path = await document(`{"agents":{"a":{"mode":"bogus"}}}`)

    const result = await read(path)

    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toEqual(["agent-skip: schema A/opencode.json"])
  })

  it("reports an unreadable document by error code, never by message", async () => {
    const path = await document("{}", "A/opencode.json")
    await rm(path)
    await mkdir(path)

    const result = await read(path)

    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toEqual(["agent-skip: unreadable A/opencode.json: EISDIR"])
  })
})
