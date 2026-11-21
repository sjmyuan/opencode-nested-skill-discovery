import path from "node:path"
import type { Permission } from "@opencode/schema/permission"
import type { IndexedAgent } from "./agent-index.ts"
import { MAX_DESCRIPTION_LENGTH } from "./contracts.ts"
import { composeName, sanitizeText } from "./names.ts"

/**
 * The agent projection (ADR agent G2–G7, G12; C1): one indexed candidate becomes one
 * registration payload with native semantics. Pure and synchronous — the registry calls it
 * once per successful index and freezes the result, so the transform replays data and
 * performs no I/O (G1).
 *
 * The name and the description derive from substituted config text, which is untrusted: the
 * subagent tool renders the description verbatim into a model-visible list, so both pass the
 * shared sanitiser before they can enter `Agent.Info`.
 */

export interface AdmittedAgent {
  readonly id: string
  /** The native name — the `agents` map key, or the file path name; G4's match key. */
  readonly nativeName: string
  readonly name: string
  readonly description?: string
  readonly system?: string
  readonly model?: IndexedAgent["model"]
  readonly steps?: number
  readonly mode?: "subagent" | "primary" | "all"
  readonly hidden?: boolean
  readonly permissions: readonly Permission.Rule[]
  readonly request: {
    readonly headers: Readonly<Record<string, string>>
    readonly body: Readonly<Record<string, unknown>>
  }
}

export interface AdmitAgentsInput {
  readonly agents: readonly IndexedAgent[]
  readonly home: string
  /** IDs the host map already held when the transform was registered (G8, C4). */
  readonly held: ReadonlySet<string>
  /** The subset of `held` the post-reload audit reported as overwritten (G9). */
  readonly shadowed?: ReadonlySet<string>
  readonly display: (canonicalPath: string) => string
}

export interface AdmitAgentsResult {
  readonly admitted: readonly AdmittedAgent[]
  readonly diagnostics: readonly string[]
}

/** The only actions whose resource is a filesystem path (`config/plugin/agent.ts:32`). */
const PATH_ACTIONS = new Set(["external_directory", "read", "edit"])

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** Mirrors `config/plugin/agent.ts:124-133`, which expands with the host's `Global.home`. */
export function expandHome(resource: string, home: string): string {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}

/**
 * Bash and shell resources are raw command text: rewriting `$HOME/x` there would miss
 * `$HOME/x/key`, and a safe rewrite needs shell-aware parsing, so they stay untouched.
 */
export function expandPermissions(rules: readonly Permission.Rule[], home: string): readonly Permission.Rule[] {
  return rules.map((rule) => (PATH_ACTIONS.has(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule))
}

export function projectAgent(candidate: IndexedAgent, home: string): AdmittedAgent {
  const request = candidate.request
  return {
    id: candidate.id,
    nativeName: candidate.name,
    name: composeName(candidate.subproject, candidate.name),
    ...(candidate.description === undefined
      ? {}
      : { description: sanitizeText(candidate.description, MAX_DESCRIPTION_LENGTH) }),
    ...(candidate.system === undefined ? {} : { system: candidate.system }),
    ...(candidate.model === undefined ? {} : { model: candidate.model }),
    ...(candidate.steps === undefined ? {} : { steps: candidate.steps }),
    ...(candidate.mode === undefined ? {} : { mode: candidate.mode }),
    ...(candidate.hidden === undefined ? {} : { hidden: candidate.hidden }),
    permissions: [
      ...expandPermissions(candidate.subprojectPermissions, home),
      ...expandPermissions(candidate.permissions ?? [], home),
    ],
    request: {
      headers: { ...(request?.headers ?? {}) },
      body: { ...(request?.body ?? {}) },
    },
  }
}

/**
 * Admission drops what must not enter the map — a disabled source, an ID the host already
 * holds, an ID a previous audit held out — and names each drop relative to the location.
 * A same-name pair in two subprojects is admitted twice: the IDs differ by scope (G12).
 */
export function admitAgents(input: AdmitAgentsInput): AdmitAgentsResult {
  const admitted: AdmittedAgent[] = []
  const diagnostics: string[] = []

  for (const candidate of input.agents) {
    const display = input.display(candidate.canonicalPath)
    if (candidate.disabled === true) {
      diagnostics.push(`agent-skip: disabled ${display}`)
      continue
    }
    if (input.held.has(candidate.id)) {
      // `shadowed` is reachable only after the audit has grown the held set; before that, every
      // held ID came from the pre-registration listing and is reported as `id-held`.
      const reason = input.shadowed?.has(candidate.id) === true ? "shadowed" : "id-held"
      diagnostics.push(`agent-skip: ${reason} ${display}`)
      continue
    }
    admitted.push(projectAgent(candidate, input.home))
  }

  return {
    admitted: admitted.sort((left, right) => compareText(left.id, right.id)),
    diagnostics: diagnostics.sort(compareText),
  }
}
