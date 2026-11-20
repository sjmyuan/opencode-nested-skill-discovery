import type { AgentCandidate } from "./contracts.ts"
import { type FamilyPass, selectSurvivorEntries } from "./family.ts"

/**
 * Agent candidates run through the delivered repo-family stage (ADR agent A11, discovery
 * R18–R20). The pass is required: one `CheckoutMemo` per refresh is a property of the
 * call, not of the caller's discipline (C3).
 *
 * F15 ships this module unwired on purpose: there is no agent index stage to consume the
 * survivors until F16, and publishing suppression diagnostics for a list nothing uses
 * would be worse than the deferral. `src/registry.ts` never calls it in this cell.
 */
export interface AgentFamilyOptions {
  readonly family: FamilyPass
}

export interface AgentFamilyResult {
  readonly agents: readonly AgentCandidate[]
  readonly diagnostics: readonly string[]
}

/** Adapter shape: the delivered `FamilyEntry` wants `realPath`, C2 carries `canonicalPath`. */
interface AgentFamilyEntry {
  readonly agent: AgentCandidate
  readonly subprojectRealPath: string
  readonly candidate: { readonly realPath: string }
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareAgent = (left: AgentCandidate, right: AgentCandidate): number => {
  if (left.canonicalPath !== right.canonicalPath) return compareText(left.canonicalPath, right.canonicalPath)
  return compareText(left.path, right.path)
}

export async function filterAgentFamilies(
  agents: readonly AgentCandidate[],
  options: AgentFamilyOptions,
): Promise<AgentFamilyResult> {
  if (agents.length === 0) return { agents, diagnostics: [] }

  // `subprojectRealPath` is already canonical (C2), and `canonicalPath` is the file's
  // realpath: the pairing key becomes the checkout-relative POSIX path, never `name`,
  // `path`, or `subproject` (A11).
  const adapted: AgentFamilyEntry[] = agents.map((agent) => ({
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
