import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Permission } from "@opencode/schema/permission"
import { Result, Schema, SchemaParser } from "effect"
import { parse, type ParseError } from "jsonc-parser"

/**
 * The config-document reader (ADR agent A10, A14, A15; contract C4 config arm).
 *
 * One document in, one `ConfigDocument` or one diagnostic out — never a partial decode.
 * Substitution and JSONC parsing mirror the pinned host
 * (`packages/core/src/config/variable.ts:25-81`, `packages/core/src/config.ts:138-149`);
 * the read set is a projection over the whole document, so an unknown top-level key is
 * ignored while one invalid agent entry drops the document as a unit.
 *
 * This module is a pure document reader: it imports no scan, index, registry or family code.
 */

export interface ConfigDocument {
  readonly path: string
  readonly canonicalPath: string
  readonly agents: ReadonlyMap<string, ConfigAgent.Info>
  readonly permissions: readonly Permission.Rule[]
  readonly defaultAgent?: string
}

export interface ReadConfigDocumentInput {
  readonly path: string
  readonly canonicalPath: string
  /** `{file:~/…}` expands against this, never against the host's real home. */
  readonly home: string
  /** The location-relative POSIX path every diagnostic carries. */
  readonly display: string
}

export interface ReadConfigDocumentResult {
  readonly document?: ConfigDocument
  readonly diagnostics: readonly string[]
}

/** A14: only these three keys are read; everything else is ignored, silently. */
const Projection = Schema.Struct({
  agents: Schema.optional(Schema.Record(Schema.String, ConfigAgent.Info)),
  permissions: Schema.optional(Permission.Ruleset),
  default_agent: Schema.optional(Schema.String),
})

const decodeProjection = SchemaParser.decodeUnknownResult(Projection)

export async function readConfigDocument(
  input: ReadConfigDocumentInput,
): Promise<ReadConfigDocumentResult> {
  let text: string
  try {
    text = await readFile(input.path, "utf8")
  } catch (error) {
    return { diagnostics: [`agent-skip: unreadable ${input.display}: ${errorCode(error)}`] }
  }

  const substituted = await substituteVariables(text, { path: input.path, home: input.home })
  const errors: ParseError[] = []
  const parsed = parse(substituted, errors, { allowTrailingComma: true })
  // A10: any JSONC error rejects the document; so does an empty one, which native also rejects.
  if (parsed === undefined || errors.length > 0) {
    return { diagnostics: [`agent-skip: malformed ${input.display}`] }
  }

  const decoded = decodeProjection(parsed, { errors: "all" })
  if (Result.isFailure(decoded)) return { diagnostics: [`agent-skip: schema ${input.display}`] }

  const projection = decoded.success
  const diagnostics =
    projection.default_agent === undefined ? [] : [`agent-default-ignored: ${input.display}`]

  return {
    document: {
      path: input.path,
      canonicalPath: input.canonicalPath,
      agents: new Map(Object.entries(projection.agents ?? {})),
      permissions: projection.permissions ?? [],
      ...(projection.default_agent === undefined ? {} : { defaultAgent: projection.default_agent }),
    },
    diagnostics,
  }
}

/**
 * D6: `{env:}` raw, then `{file:}`, then the escaped retry when the raw pass produced JSON
 * the parser rejects (`packages/core/src/config/variable.ts:25-38`). Never throws: a missing
 * or unreadable `{file:}` substitutes empty, exactly as native does.
 */
export async function substituteVariables(
  text: string,
  source: { readonly path: string; readonly home: string },
): Promise<string> {
  const env = (escape: boolean): string =>
    text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const value = process.env[name] || ""
      return escape ? JSON.stringify(value).slice(1, -1) : value
    })

  const raw = await substituteFiles(env(false), source)
  const errors: ParseError[] = []
  if (text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  if (errors.length === 0) return raw
  return substituteFiles(env(true), source)
}

/** `packages/core/src/config/variable.ts:40-81`, including the `//`-prefixed line skip. */
async function substituteFiles(
  text: string,
  source: { readonly path: string; readonly home: string },
): Promise<string> {
  const configDir = dirname(source.path)
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index ?? 0
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expanded = filePath.startsWith("~/") ? join(source.home, filePath.slice(2)) : filePath
    const resolvedPath = isAbsolute(expanded) ? expanded : resolve(configDir, expanded)
    let content = ""
    try {
      content = await readFile(resolvedPath, "utf8")
    } catch {
      content = ""
    }

    out += JSON.stringify(content.trim()).slice(1, -1)
    cursor = index + token.length
  }

  return out + text.slice(cursor)
}

/** D3: diagnostics carry `error.code`, never `Error.message` (which embeds absolute paths). */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "UNKNOWN"
}
