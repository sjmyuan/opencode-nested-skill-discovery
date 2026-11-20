import { ConfigAgent } from "@opencode/schema/config/agent"
import { Permission } from "@opencode/schema/permission"
import { Result, SchemaParser } from "effect"
import matter from "gray-matter"

/**
 * The agent-file decoder (ADR agent A9; contract C5 file arm).
 *
 * Mirrors native's `decode()` (`packages/core/src/config/plugin/agent.ts:145-196`):
 * frontmatter through gray-matter with the sanitize retry
 * (`packages/core/src/config/markdown.ts:4-41`), the legacy bare `model` + `variant` join,
 * and the pre-V2 frontmatter branch as a **refusal**. Such a file is skipped with one
 * diagnostic; no pre-V2 schema, normalize or migration code is imported (G13).
 */

export interface AgentModel {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface AgentRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly body: Readonly<Record<string, unknown>>
}

export interface AgentFields {
  readonly system?: string
  readonly description?: string
  readonly model?: AgentModel
  readonly mode?: "subagent" | "primary" | "all"
  readonly hidden?: boolean
  readonly color?: string
  readonly steps?: number
  readonly disabled?: boolean
  readonly permissions?: readonly Permission.Rule[]
  readonly request?: AgentRequest
}

export type AgentDecode =
  | { readonly ok: true; readonly fields: AgentFields; readonly diagnostics: readonly string[] }
  | { readonly ok: false; readonly reason: "markdown" | "legacy" | "schema" }

/** `variant` is V2-shaped but not a `ConfigAgent.Info` field, so it is never "unsupported". */
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])
/** Fields only V2 understands. A file that uses any of them is read as V2, whatever else it holds. */
const nativeKeys = ["permissions", "request", "system", "disabled"]

const decodeAgent = SchemaParser.decodeUnknownResult(ConfigAgent.Info)

export function decodeAgentFile(text: string, display: string): AgentDecode {
  const parsed = parse(text)
  if (parsed === undefined) return { ok: false, reason: "markdown" }

  const data = parsed.data as Record<string, unknown>
  const keys = Object.keys(data)
  const unsupported = keys.filter((key) => !agentKeys.has(key))
  const legacy = unsupported.length > 0 && !keys.some((key) => nativeKeys.includes(key))
  if (legacy) return { ok: false, reason: "legacy" }

  const diagnostics =
    unsupported.length === 0 ? [] : [`agent-field: ${display} ignored ${unsupported.join(",")}`]

  const decoded = decodeAgent(withJoinedModel(data, parsed.content.trim()), { errors: "all" })
  if (Result.isFailure(decoded)) return { ok: false, reason: "schema" }

  return { ok: true, fields: toFields(decoded.success), diagnostics }
}

function parse(text: string): matter.GrayMatterFile<string> | undefined {
  // Passing options bypasses gray-matter's module-global cache, which a failed YAML parse
  // poisons; without it the sanitize retry never runs (`markdown.ts:4-13`).
  try {
    return matter(text, {})
  } catch {
    try {
      return matter(sanitize(text), {})
    } catch {
      return undefined
    }
  }
}

/**
 * The legacy bare `model: provider/id` + `variant: fast` pair becomes the `#` form native
 * already understands, so the rest of the frontmatter never goes through V1 migration.
 */
function withJoinedModel(data: Record<string, unknown>, body: string): unknown {
  const model = data.model
  const variant = data.variant
  const joined =
    typeof model === "string" && !model.includes("#") && typeof variant === "string" && /^[^#]+$/.test(variant)
      ? { ...data, model: `${model}#${variant}` }
      : data
  return { ...joined, system: body }
}

/** Map the decoded class to plain fields, so no schema class instance leaves this module. */
function toFields(info: ConfigAgent.Info): AgentFields {
  const model = info.model
  const request = info.request
  return {
    system: info.system,
    ...(info.description === undefined ? {} : { description: info.description }),
    ...(model === undefined
      ? {}
      : {
          model: {
            providerID: model.providerID,
            id: model.model,
            ...(model.variant === undefined ? {} : { variant: model.variant }),
          },
        }),
    ...(info.mode === undefined ? {} : { mode: info.mode }),
    ...(info.hidden === undefined ? {} : { hidden: info.hidden }),
    ...(info.color === undefined ? {} : { color: info.color }),
    ...(info.steps === undefined ? {} : { steps: info.steps }),
    ...(info.disabled === undefined ? {} : { disabled: info.disabled }),
    ...(info.permissions === undefined
      ? {}
      : {
          permissions: info.permissions.map((rule) => ({
            action: rule.action,
            resource: rule.resource,
            effect: rule.effect,
          })),
        }),
    ...(request === undefined
      ? {}
      : { request: { headers: { ...(request.headers ?? {}) }, body: { ...(request.body ?? {}) } } }),
  }
}

/**
 * Retry unquoted colons and leading tags as YAML block scalars
 * (`packages/core/src/config/markdown.ts:26-41`), so existing agent files keep working.
 */
function sanitize(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1] ?? ""
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = (entry[2] ?? "").trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":") && !/^[[{].*[\]}]\s*\S/.test(value)) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
