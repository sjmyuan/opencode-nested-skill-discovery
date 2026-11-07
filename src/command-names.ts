import { relative, sep } from "node:path"
import { compareText } from "./contracts.ts"
import type { CommandCandidate } from "./contracts.ts"

/** A published name plus F1's candidate; every other field keeps its scanned meaning. */
export interface QualifiedCommand extends CommandCandidate {
  readonly publishedName: string
}

export interface CommandNameResult {
  readonly commands: readonly QualifiedCommand[]
  readonly diagnostics: readonly string[]
}

/**
 * `<qualifier>:<command>` as the registry and invocation key (ADR command R1, R2; plan PD1–PD3).
 *
 * The location is never qualified, so an empty part contributes nothing instead of a
 * leading or trailing separator.
 */
export function composeCommandName(subproject: string, nativeName: string): string {
  const qualifier = normalisePart(subproject)
  const command = normalisePart(nativeName)

  if (qualifier.length === 0) return command
  if (command.length === 0) return qualifier

  return `${qualifier}:${command}`
}

/**
 * One winner per composed name, in canonical-path order (ADR command R3; plan PD6, PD9).
 *
 * The input is re-sorted so the snapshot order never depends on the caller, and the
 * dropped entry is reported with its location-relative path so no absolute path leaks.
 */
export function composeCommandNames(
  commands: readonly CommandCandidate[],
  location: string,
): CommandNameResult {
  const planned: QualifiedCommand[] = commands.map((command) => ({
    ...command,
    publishedName: composeCommandName(command.subproject, command.name),
  }))
  const seen = new Set<string>()
  const kept: QualifiedCommand[] = []
  const diagnostics: string[] = []

  for (const command of planned.sort(compareCommand)) {
    if (command.publishedName.length === 0) {
      diagnostics.push(`name-empty: ${relativeTo(location, command.path)}`)
      continue
    }
    if (seen.has(command.publishedName)) {
      diagnostics.push(`name-collision: ${command.publishedName} (${relativeTo(location, command.path)})`)
      continue
    }
    seen.add(command.publishedName)
    kept.push(command)
  }

  return { commands: kept, diagnostics }
}

function normalisePart(value: string): string {
  // R1 order: consume a literal `:` before `/` becomes the separator.
  return value
    .replace(/:/g, "-")
    .replace(/\//g, ":")
    .replace(/\s/g, "-")
    .replace(/[\u0000-\u001F]/g, "")
}

function compareCommand(left: CommandCandidate, right: CommandCandidate): number {
  if (left.canonicalPath !== right.canonicalPath) {
    return compareText(left.canonicalPath, right.canonicalPath)
  }
  if (left.path !== right.path) return compareText(left.path, right.path)
  return compareText(left.name, right.name)
}

function relativeTo(location: string, path: string): string {
  return relative(location, path).split(sep).join("/")
}
