import { describe, expect, it } from "vitest"
import { decodeAgentFile } from "../src/agent-decode.ts"

/**
 * F16 Step 5 (ADR agent A9; contract C5 file arm). The file decoder mirrors native's
 * `decode()` (`packages/core/src/config/plugin/agent.ts:145-196`): frontmatter through
 * gray-matter with the sanitize retry, the bare `model` + `variant` join, the V1 **refusal**
 * (a skip, never a migration — G13), and one warning for ignored keys.
 */

const file = (frontmatter: string, body = "Body text\n"): string => `---\n${frontmatter}---\n${body}`

const ok = (result: ReturnType<typeof decodeAgentFile>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result
}

describe("agent file decode", () => {
  it("decodes the native fields and the body as system", () => {
    const result = ok(decodeAgentFile(file("description: d\nmode: subagent\nmodel: openai/gpt\n"), "A"))

    expect(result.diagnostics).toEqual([])
    expect(result.fields).toEqual({
      system: "Body text",
      description: "d",
      mode: "subagent",
      model: { providerID: "openai", id: "gpt" },
    })
  })

  it("decodes permissions, request, steps, hidden and disabled", () => {
    const text = file(
      [
        "description: d",
        "steps: 3",
        "hidden: true",
        "disabled: false",
        "permissions:",
        "  - action: read",
        "    resource: '**'",
        "    effect: allow",
        "request:",
        "  headers:",
        "    x-trace: yes",
        "  body:",
        "    temperature: 0.2",
        "",
      ].join("\n"),
    )

    const result = ok(decodeAgentFile(text, "A"))

    expect(result.diagnostics).toEqual([])
    expect(result.fields.permissions).toEqual([{ action: "read", resource: "**", effect: "allow" }])
    expect(result.fields.request?.headers).toEqual({ "x-trace": "yes" })
    expect(result.fields.request?.body).toEqual({ temperature: 0.2 })
    expect(result.fields.steps).toBe(3)
    expect(result.fields.hidden).toBe(true)
    expect(result.fields.disabled).toBe(false)
  })

  it("joins a bare model with variant, and leaves a # form alone", () => {
    const joined = ok(decodeAgentFile(file("model: openai/gpt\nvariant: fast\n"), "A"))
    expect(joined.fields.model).toEqual({ providerID: "openai", id: "gpt", variant: "fast" })

    const embedded = ok(decodeAgentFile(file("model: openai/gpt#fast\nvariant: slow\n"), "A"))
    expect(embedded.fields.model).toEqual({ providerID: "openai", id: "gpt", variant: "fast" })
  })

  it("retries the sanitized frontmatter for an unquoted colon", () => {
    const result = ok(decodeAgentFile(file("description: note: with a colon\n"), "A"))

    expect(result.fields.description).toBe("note: with a colon")
  })

  it("keeps a bare body as system with no other field and no diagnostic", () => {
    const result = ok(decodeAgentFile("# Translator\n", "A"))

    expect(result.diagnostics).toEqual([])
    expect(result.fields).toEqual({ system: "# Translator" })
  })

  it("refuses a V1 legacy file instead of migrating it", () => {
    const result = decodeAgentFile(file("name: x\ntools: [read]\n", "body\n"), "A")

    expect(result).toEqual({ ok: false, reason: "legacy" })
  })

  it("reads a file that mixes a V1 key with a native key as V2 and warns about the key", () => {
    const result = ok(decodeAgentFile(file("name: x\nsystem: native prompt\n", "body\n"), "A"))

    expect(result.fields.system).toBe("body")
    expect(result.diagnostics).toEqual(["agent-field: A ignored name"])
  })

  it("reports a schema failure for an undecodable frontmatter value", () => {
    expect(decodeAgentFile(file("mode: nope\n"), "A")).toEqual({ ok: false, reason: "schema" })
  })

  it("reports markdown when the frontmatter never parses", () => {
    expect(decodeAgentFile(file("description: [unclosed\n"), "A")).toEqual({ ok: false, reason: "markdown" })
  })
})
