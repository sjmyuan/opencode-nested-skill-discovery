import type { CommandCandidate } from "./contracts.ts"
import { type FamilyPass, selectSurvivorEntries } from "./family.ts"

/**
 * Command candidates run through the delivered repo-family stage (ADR command R8,
 * discovery R18–R20). The pass is required: one `CheckoutMemo` per refresh is a
 * property of the call, not of the caller's discipline (PD4).
 */
export interface CommandFamilyOptions {
  readonly family: FamilyPass
}

export interface CommandFamilyResult {
  readonly commands: readonly CommandCandidate[]
  readonly diagnostics: readonly string[]
}

/** Adapter shape: the delivered `FamilyEntry` wants `realPath`, F1 carries `canonicalPath` (PD1). */
interface CommandFamilyEntry {
  readonly command: CommandCandidate
  readonly subprojectRealPath: string
  readonly candidate: { readonly realPath: string }
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareCommand = (left: CommandCandidate, right: CommandCandidate): number => {
  if (left.canonicalPath !== right.canonicalPath) return compareText(left.canonicalPath, right.canonicalPath)
  return compareText(left.path, right.path)
}

export async function filterCommandFamilies(
  commands: readonly CommandCandidate[],
  options: CommandFamilyOptions,
): Promise<CommandFamilyResult> {
  if (commands.length === 0) return { commands, diagnostics: [] }

  // `subprojectRealPath` is already canonical (F1), and `canonicalPath` is the file's
  // realpath: the pairing key becomes the checkout-relative POSIX path, never `name`,
  // `path`, or `subproject` (PD1, pinned by C2).
  const adapted: CommandFamilyEntry[] = commands.map((command) => ({
    command,
    subprojectRealPath: command.subprojectRealPath,
    candidate: { realPath: command.canonicalPath },
  }))
  const checkouts = [...new Set(adapted.map((entry) => entry.subprojectRealPath))]
  const derived = await options.family.derive(checkouts)
  const selected = selectSurvivorEntries(adapted, derived.families, options.family.location)

  return {
    commands: selected.kept.map((entry) => entry.command).sort(compareCommand),
    diagnostics: [...derived.diagnostics, ...selected.diagnostics].sort(compareText),
  }
}
