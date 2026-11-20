import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { AdmittedAgent } from "./agent-project.ts"

/**
 * The post-reload agent audit (ADR agent G8, G9; C5).
 *
 * The map is rebuilt from the transform on reload, then the location's rules are appended to
 * every entry (`config/plugin/agent.ts:64-67`). This comparison is what proves our entry
 * survived that rebuild: an entry a later producer edited, or one that never appeared, is
 * reported once and held out of the next snapshot (removal by omission, G9).
 */

export interface ListedAgent {
  readonly id: string
  readonly mode?: "subagent" | "primary" | "all"
  readonly hidden?: boolean
  readonly system?: string
  readonly description?: string
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
  readonly steps?: number
  readonly permissions?: readonly Permission.Rule[]
  readonly request?: {
    readonly settings?: unknown
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: Readonly<Record<string, unknown>>
  }
}

export interface AuditAgentsInput {
  readonly agents: readonly AdmittedAgent[]
  readonly shadowed: ReadonlySet<string>
  readonly list: () => Promise<{ readonly data: readonly ListedAgent[] }>
}

export interface AuditAgentsResult {
  readonly shadowed: readonly string[]
  readonly diagnostics: readonly string[]
}

export async function auditReloadedAgents(input: AuditAgentsInput): Promise<AuditAgentsResult> {
  const listed = await input.list()
  const byId = new Map(listed.data.map((entry) => [String(entry.id), entry]))
  const shadowed: string[] = []
  const diagnostics: string[] = []

  for (const agent of input.agents) {
    if (input.shadowed.has(agent.id)) continue

    const row = byId.get(agent.id)
    if (row !== undefined && survives(agent, row)) continue

    shadowed.push(agent.id)
    diagnostics.push(`agent-shadow-audit: ${agent.id}`)
  }

  return { shadowed, diagnostics }
}

/**
 * The published ruleset starts with the insert seed's four rules, then ours; anything after is
 * the location's own suffix (D7). A rule inserted, removed or reordered inside our prefix is a
 * mismatch, and so is any field a later producer changed (D8 compares `headers`/`body` only).
 */
function survives(agent: AdmittedAgent, row: ListedAgent): boolean {
  if ((row.mode ?? "primary") !== (agent.mode ?? "primary")) return false
  if ((row.hidden ?? false) !== (agent.hidden ?? false)) return false
  if (row.system !== agent.system) return false
  if (row.description !== agent.description) return false
  if (row.steps !== agent.steps) return false
  if (!sameModel(agent, row)) return false
  if (!sameRecord(agent.request.headers, row.request?.headers)) return false
  if (!sameRecord(agent.request.body, row.request?.body)) return false
  return hasPrefix(row.permissions ?? [], agent)
}

function sameModel(agent: AdmittedAgent, row: ListedAgent): boolean {
  const expected = agent.model
  const actual = row.model
  if (expected === undefined) return actual === undefined
  if (actual === undefined) return false
  return (
    actual.id === expected.id &&
    actual.providerID === expected.providerID &&
    (actual.variant ?? undefined) === (expected.variant ?? undefined)
  )
}

function hasPrefix(published: readonly Permission.Rule[], agent: AdmittedAgent): boolean {
  const seed = Agent.Info.default(agent.id as Agent.ID).permissions
  const expected = [...seed, ...agent.permissions]
  if (published.length < expected.length) return false

  return expected.every((rule, index) => {
    const actual = published[index]
    return (
      actual !== undefined &&
      actual.action === rule.action &&
      actual.resource === rule.resource &&
      actual.effect === rule.effect
    )
  })
}

const sameRecord = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>> | undefined): boolean => {
  if (right === undefined) return Object.keys(left).length === 0
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== "object" || typeof right !== "object") return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every((key) => key in rightRecord && deepEqual(leftRecord[key], rightRecord[key]))
}
