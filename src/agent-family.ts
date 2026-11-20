import { type FamilyPass, selectSurvivorEntries } from "./family.ts"

/**
 * Agent candidates run through the delivered repo-family stage (ADR agent A11, discovery
 * R18–R20). The pass is required: one `CheckoutMemo` per refresh is a property of the
 * call, not of the caller's discipline (C3).
 *
 * F16 widens the adapter to a structural entry, because the merge produces one entry per
 * (subproject, native name) that may be owned by a config document or an agent file. The
 * sort keys, the pairing key and the diagnostics are unchanged: `canonicalPath` is the
 * token owner's source, so a config-owned entry pairs on the same checkout-relative path
 * a file entry would.
 */
export interface AgentFamilyEntry {
  readonly canonicalPath: string
  readonly subprojectRealPath: string
  readonly subproject: string
  readonly path: string
}

export interface AgentFamilyOptions {
  readonly family: FamilyPass
}

export interface AgentFamilyResult<T extends AgentFamilyEntry> {
  readonly agents: readonly T[]
  readonly diagnostics: readonly string[]
}

/** Adapter shape: the delivered `FamilyEntry` wants `realPath`, the entry carries `canonicalPath`. */
interface Adapted<T extends AgentFamilyEntry> {
  readonly agent: T
  readonly subprojectRealPath: string
  readonly candidate: { readonly realPath: string }
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareAgent = (left: AgentFamilyEntry, right: AgentFamilyEntry): number => {
  if (left.canonicalPath !== right.canonicalPath) return compareText(left.canonicalPath, right.canonicalPath)
  return compareText(left.path, right.path)
}

export async function filterAgentFamilies<T extends AgentFamilyEntry>(
  agents: readonly T[],
  options: AgentFamilyOptions,
): Promise<AgentFamilyResult<T>> {
  if (agents.length === 0) return { agents, diagnostics: [] }

  // `subprojectRealPath` is already canonical, and `canonicalPath` is the token owner's
  // realpath: the pairing key becomes the checkout-relative POSIX path, never `name`,
  // `path`, or `subproject` (A11).
  const adapted: Adapted<T>[] = agents.map((agent) => ({
    agent,
    subprojectRealPath: agent.subprojectRealPath,
    candidate: { realPath: agent.canonicalPath },
  }))
  const checkouts = [...new Set(adapted.map((entry) => entry.subprojectRealPath))]
  const derived = await options.family.derive(checkouts)
  const selected = selectSurvivorEntries(adapted, derived.families, options.family.location)

  return {
    agents: selected.kept.map((entry) => entry.agent).sort(compareAgent),
    diagnostics: [...new Set([...derived.diagnostics, ...selected.diagnostics])].sort(compareText),
  }
}
