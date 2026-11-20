import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parse } from "jsonc-parser"
import { readConfigDocument, substituteVariables } from "../src/agent-config.ts"

/**
 * F16 Step 4 (ADR agent A10, A14, A15): one document in, one `ConfigDocument` or one
 * diagnostic out. Substitution and JSONC mirror the pinned host
 * (`packages/core/src/config/variable.ts:25-81`, `config.ts:138-149`); the read set is a
 * projection, so an unknown key is ignored and one invalid entry drops the document whole.
 */

const created: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nested-agent-config-"))
  created.push(root)
  return root
}

afterEach(async () => {
  delete process.env.F16_DESC
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function document(text: string, rel = "A/opencode.json"): Promise<string> {
  const root = await workspace()
  const path = join(root, rel)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, text)
  return path
}

const read = async (
  path: string,
  display = "A/opencode.json",
  home = "/home/test",
): Promise<Awaited<ReturnType<typeof readConfigDocument>>> =>
  readConfigDocument({ path, canonicalPath: path, home, display })

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

    const substituted = await substituteVariables(text, { path, home: "/home/test" })
    const errors: unknown[] = []
    parse(substituted, errors as never, { allowTrailingComma: true })
    expect(errors).toEqual([])
    expect((await read(path)).document?.agents.get("a")?.description).toBe('a"b\\c')
  })

  it("inlines a {file:} reference relative to the document, trimmed", async () => {
    const path = await document(`{"agents":{"a":{"description":"{file:./prompt.md}"}}}`, "A/opencode.json")
    await writeFile(join(path, "..", "prompt.md"), "  body text\n")

    const result = await read(path)

    expect(result.document?.agents.get("a")?.description).toBe("body text")
  })

  it("expands {file:~/...} against the injected home", async () => {
    const home = await workspace()
    await writeFile(join(home, "snippet.md"), "home text\n")
    const path = await document(`{"agents":{"a":{"description":"{file:~/snippet.md}"}}}`)

    const result = await read(path, "A/opencode.json", home)

    expect(result.document?.agents.get("a")?.description).toBe("home text")
  })

  it("substitutes empty for a missing {file:} and leaves a commented token verbatim", async () => {
    const path = await document(
      `{\n// {file:./missing.md}\n"agents":{"a":{"description":"{file:./missing.md}"}}}`,
    )

    const result = await read(path)

    expect(result.diagnostics).toEqual([])
    expect(result.document?.agents.get("a")?.description).toBe("")
    const text = await readFile(path, "utf8")
    expect(await substituteVariables(text, { path, home: "/home/test" })).toContain("// {file:./missing.md}")
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
