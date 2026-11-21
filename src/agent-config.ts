import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Permission } from "@opencode/schema/permission"
import { Result, Schema, SchemaParser } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import type { ScanLimits } from "./contracts.ts"

/**
 * The config-document reader (ADR agent A10, A14, A15; contract C4 config arm).
 *
 * One document in, one `ConfigDocument` or one diagnostic out — never a partial decode.
 * JSONC parsing mirrors the pinned host (`packages/core/src/config.ts:138-149`); `{file:}`
 * substitution deliberately diverges from it: a reference is confined to the marked
 * directory's realpath, capped, and read at most once (ADR agent A10).
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

/** A10: the caps are the R8 option values, counted per document, never charged to the scan. */
export type SubstitutionLimits = Pick<ScanLimits, "maxFileBytes" | "maxTotalBytes">

export interface ReadConfigDocumentInput {
  readonly path: string
  readonly canonicalPath: string
  /** The marked directory `d` of A10: every `{file:}` must resolve inside its realpath. */
  readonly rootRealPath: string
  /**
   * Never expanded and never consulted: every reference is resolved against the document, and a
   * `~`-leading one is refused outright. It is threaded through so the `~`-refusal fixture can
   * supply a real home and prove a home cannot unblock a token.
   */
  readonly home: string
  /** The location-relative POSIX path every diagnostic carries. */
  readonly display: string
  readonly limits: SubstitutionLimits
}

export interface ReadConfigDocumentResult {
  readonly document?: ConfigDocument
  readonly diagnostics: readonly string[]
}

export type Refusal = "outside-root" | "cap-file" | "cap-total"

export interface SubstitutionResult {
  readonly text: string
  readonly diagnostics: readonly string[]
}

/** A14: only these three keys are read; everything else is ignored, silently. */
const decodeAgents = SchemaParser.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))
const decodePermissions = SchemaParser.decodeUnknownResult(Permission.Ruleset)
const decodeDefaultAgent = SchemaParser.decodeUnknownResult(Schema.String)
const decodeAgentEntry = SchemaParser.decodeUnknownResult(ConfigAgent.Info)

export async function readConfigDocument(
  input: ReadConfigDocumentInput,
): Promise<ReadConfigDocumentResult> {
  let text: string
  try {
    text = await readFile(input.path, "utf8")
  } catch (error) {
    return { diagnostics: [`agent-skip: unreadable ${input.display}: ${errorCode(error)}`] }
  }

  const substituted = await substituteConfined(text, {
    path: input.path,
    rootRealPath: input.rootRealPath,
    home: input.home,
    display: input.display,
    limits: input.limits,
  })
  const refusals = substituted.diagnostics
  const errors: ParseError[] = []
  const parsed = parse(substituted.text, errors, { allowTrailingComma: true })
  // A10: any JSONC error rejects the document; so does an empty one, which native also rejects.
  if (parsed === undefined || errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { diagnostics: [...refusals, `agent-skip: malformed ${input.display}`] }
  }
  const fields = parsed as Record<string, unknown>

  // A15/D11: the read set is checked in a fixed order; the first failure drops the document
  // with one line naming the field whose rules are lost.
  const agentsField = fields.agents
  let rawAgents: Readonly<Record<string, unknown>> = {}
  if (agentsField !== undefined) {
    const decoded = decodeAgents(agentsField, { errors: "all" })
    if (Result.isFailure(decoded)) {
      return { diagnostics: [...refusals, `agent-skip: ${input.display}: agents schema`] }
    }
    rawAgents = decoded.success
  }

  const permissionsField = fields.permissions
  let permissions: readonly Permission.Rule[] = []
  if (permissionsField !== undefined) {
    const decoded = decodePermissions(permissionsField, { errors: "all" })
    if (Result.isFailure(decoded)) {
      return { diagnostics: [...refusals, `agent-skip: ${input.display}: permissions schema`] }
    }
    permissions = decoded.success
  }

  const defaultField = fields.default_agent
  let defaultAgent: string | undefined
  if (defaultField !== undefined) {
    const decoded = decodeDefaultAgent(defaultField, { errors: "all" })
    if (Result.isFailure(decoded)) {
      return { diagnostics: [...refusals, `agent-skip: ${input.display}: default_agent schema`] }
    }
    defaultAgent = decoded.success
  }

  // A15: one bad key drops that key only — its siblings and the document's top-level rules
  // survive, so a nested `deny` can no longer be erased by an unrelated entry.
  const agents = new Map<string, ConfigAgent.Info>()
  const dropped: string[] = []
  for (const [key, value] of Object.entries(rawAgents)) {
    const decoded = decodeAgentEntry(value, { errors: "all" })
    if (Result.isFailure(decoded)) {
      dropped.push(`agent-skip: ${input.display}: entry ${key} schema`)
      continue
    }
    agents.set(key, decoded.success)
  }

  return {
    document: {
      path: input.path,
      canonicalPath: input.canonicalPath,
      agents,
      permissions,
      ...(defaultAgent === undefined ? {} : { defaultAgent }),
    },
    diagnostics: [
      ...refusals,
      ...(defaultAgent === undefined ? [] : [`agent-default-ignored: ${input.display}`]),
      ...dropped,
    ],
  }
}

export interface SubstitutionSource {
  readonly path: string
  /** The marked directory `d`, canonicalised once by {@link substituteConfined}. */
  readonly rootRealPath: string
  /** Carried for the same reason as {@link ReadConfigDocumentInput.home}: a real home must not help. */
  readonly home: string
  readonly display: string
  readonly limits: SubstitutionLimits
}

/**
 * A10: `{env:}` raw, then `{file:}` confined to the marked directory, then the escaped retry
 * when the raw pass produced JSON the parser rejects (`packages/core/src/config/variable.ts:25-38`).
 * Never throws. A refused reference substitutes empty with one `file-ref … <reason>` line and
 * is never opened; one cache per document means the escaped retry reuses a read, never causes
 * one, and a rejected token is never re-read.
 */
export async function substituteConfined(
  text: string,
  source: SubstitutionSource,
): Promise<SubstitutionResult> {
  // D3: "the realpath of the marked directory", canonicalised once and fail-closed — with a
  // non-canonical root the containment test simply refuses every reference. The document's
  // directory is canonicalised with it, so a non-canonical document path (a symlinked
  // ancestor, which is what `tmpdir()` gives) never refuses a legitimate reference.
  const [root, configDir] = await Promise.all([
    realpath(source.rootRealPath).catch(() => source.rootRealPath),
    realpath(dirname(source.path)).catch(() => dirname(source.path)),
  ])
  const cache = new Map<string, string>()
  const reported = new Set<string>()
  let bytes = 0

  const refuse = (token: string, reason: Refusal): string => {
    if (!reported.has(token)) {
      reported.add(token)
      diagnostics.push(`agent-skip: ${source.display}: file-ref ${token} ${reason}`)
    }
    cache.set(token, "")
    return ""
  }

  const diagnostics: string[] = []

  const files = async (raw: string): Promise<string> => {
    let out = ""
    let cursor = 0

    for (const match of raw.matchAll(/\{file:[^}]+\}/g)) {
      const token = match[0]
      const index = match.index ?? 0
      out += raw.slice(cursor, index)

      const lineStart = raw.lastIndexOf("\n", index - 1) + 1
      if (raw.slice(lineStart, index).trimStart().startsWith("//")) {
        out += token
        cursor = index + token.length
        continue
      }

      const cached = cache.get(token)
      if (cached !== undefined) {
        out += cached
        cursor = index + token.length
        continue
      }

      const literal = token.slice("{file:".length, -1)
      // D5: the lexical refusal precedes every filesystem call, so "never opened" holds.
      if (literal.startsWith("~") || isAbsolute(literal)) {
        out += refuse(token, "outside-root")
        cursor = index + token.length
        continue
      }
      const resolved = resolve(configDir, literal)
      if (!inside(root, resolved)) {
        out += refuse(token, "outside-root")
        cursor = index + token.length
        continue
      }

      // D4: follow, then confine — `stat` decides regularity, `realpath` decides containment.
      let size: number
      try {
        const stats = await stat(resolved)
        if (!stats.isFile()) throw new Error("not a regular file")
        size = stats.size
      } catch {
        out += refuse(token, "outside-root")
        cursor = index + token.length
        continue
      }

      let real: string
      try {
        real = await realpath(resolved)
      } catch {
        out += refuse(token, "outside-root")
        cursor = index + token.length
        continue
      }
      // An intermediate directory symlink passes `stat`; only this check catches it.
      if (!inside(root, real)) {
        out += refuse(token, "outside-root")
        cursor = index + token.length
        continue
      }

      // D6: capped from `stat().size`; a refused reference never charges the ledger.
      if (size > source.limits.maxFileBytes) {
        out += refuse(token, "cap-file")
        cursor = index + token.length
        continue
      }
      if (bytes + size > source.limits.maxTotalBytes) {
        out += refuse(token, "cap-total")
        cursor = index + token.length
        continue
      }
      bytes += size

      let content: string
      try {
        content = await readFile(real, "utf8")
      } catch {
        out += refuse(token, "outside-root")
        cursor = index + token.length
        continue
      }
      const replacement = JSON.stringify(content.trim()).slice(1, -1)
      cache.set(token, replacement)
      out += replacement
      cursor = index + token.length
    }

    return out + raw.slice(cursor)
  }

  const env = (escape: boolean): string =>
    text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const value = process.env[name] || ""
      return escape ? JSON.stringify(value).slice(1, -1) : value
    })

  const raw = await files(env(false))
  const errors: ParseError[] = []
  if (text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  const substituted = errors.length === 0 ? raw : await files(env(true))

  return { text: substituted, diagnostics }
}

/** A10: containment by `relative`, never by spotting `..` in the token. */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** D3: diagnostics carry `error.code`, never `Error.message` (which embeds absolute paths). */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "UNKNOWN"
}
