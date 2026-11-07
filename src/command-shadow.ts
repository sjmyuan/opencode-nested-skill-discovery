import type { NativeCommandNameIndex } from "./command-native.ts"

/**
 * Native precedence for command names (ADR command R4; plan PD1, PD7, PD8).
 *
 * A planned entry is compared by its published name — never the pre-qualification native
 * name — against the names the filesystem native walk derives and the names an earlier
 * pass already denied. The caller's order is kept, and a drop is reported once per name.
 */
export interface Nameable {
  readonly name: string
  readonly canonicalPath: string
}

export interface DropInput {
  readonly native: NativeCommandNameIndex
  /** Names an earlier pass already suppressed; they are dropped without repeating the report. */
  readonly denied?: readonly string[]
}

export interface DropOutcome<T extends Nameable> {
  readonly kept: readonly T[]
  readonly dropped: readonly T[]
  readonly diagnostics: readonly string[]
}

export function dropNativeCollisions<T extends Nameable>(
  planned: readonly T[],
  { native, denied = [] }: DropInput,
): DropOutcome<T> {
  const owned = new Set(native.names)
  const suppressed = new Set(denied)
  const kept: T[] = []
  const dropped: T[] = []
  const diagnostics = [...native.diagnostics]

  for (const entry of planned) {
    if (suppressed.has(entry.name)) {
      dropped.push(entry)
      continue
    }
    if (!owned.has(entry.name)) {
      kept.push(entry)
      continue
    }
    dropped.push(entry)
    const line = `native-shadow: ${entry.name}`
    if (!diagnostics.includes(line)) diagnostics.push(line)
  }

  return { kept, dropped, diagnostics }
}

/**
 * Post-reload classification (ADR command R4; plan PD6, PD10).
 *
 * The listing is `ctx.command.list()`'s data, so membership in the published set decides
 * ours — never the `:` prefix. A differing description is a shadow, an identical one is
 * indistinguishable, a published name missing from the listing is absent, and every listed
 * name no published entry explains is foreign and stays silent.
 */
export interface ListedCommand {
  readonly name: string
  readonly description?: string
}

export interface PublishedCommand extends Nameable {
  readonly description?: string
}

export interface AuditInput {
  readonly listed: readonly ListedCommand[]
  readonly published: readonly PublishedCommand[]
  /** Accepted so F5 passes one index to both stages; a native name is foreign here. */
  readonly native: NativeCommandNameIndex
}

export interface AuditOutcome {
  readonly shadowed: readonly string[]
  readonly absent: readonly string[]
  readonly foreign: readonly string[]
  readonly diagnostics: readonly string[]
}

export function auditCommandList({ listed, published }: AuditInput): AuditOutcome {
  const listedByName = new Map<string, ListedCommand>()
  for (const entry of listed) {
    if (!listedByName.has(entry.name)) listedByName.set(entry.name, entry)
  }
  const publishedNames = new Set(published.map((entry) => entry.name))
  const shadowed: string[] = []
  const absent: string[] = []
  const diagnostics: string[] = []

  const report = (line: string): void => {
    if (!diagnostics.includes(line)) diagnostics.push(line)
  }

  for (const entry of published) {
    const found = listedByName.get(entry.name)
    if (found === undefined) {
      if (!absent.includes(entry.name)) absent.push(entry.name)
      report(`command-absent: ${entry.name}`)
      continue
    }
    if (found.description === entry.description) continue
    if (!shadowed.includes(entry.name)) shadowed.push(entry.name)
    report(`native-shadow-audit: ${entry.name}`)
  }

  const foreign = listed
    .map((entry) => entry.name)
    .filter((name, index, names) => !publishedNames.has(name) && names.indexOf(name) === index)

  return { shadowed, absent, foreign, diagnostics }
}

/**
 * The cross-pass ledger (ADR command R4; plan PD7, PD8).
 *
 * A denial is kept while a native file derives the name or the listing still holds it,
 * and forgotten only when both are gone. Diagnostics are reported once per `reason|name`
 * for the lifetime of the tracker, so an unchanged rescan stays silent.
 */
export interface ShadowTracker {
  readonly drop: <T extends Nameable>(planned: readonly T[], native: NativeCommandNameIndex) => DropOutcome<T>
  readonly audit: (input: AuditInput) => AuditOutcome
}

export function createShadowTracker(): ShadowTracker {
  const denied = new Set<string>()
  const reported = new Set<string>()

  const fresh = (diagnostics: readonly string[]): readonly string[] =>
    diagnostics.filter((line) => {
      const key = diagnosticKey(line)
      if (reported.has(key)) return false
      reported.add(key)
      return true
    })

  return {
    drop<T extends Nameable>(planned: readonly T[], native: NativeCommandNameIndex): DropOutcome<T> {
      const outcome = dropNativeCollisions(planned, { native, denied: [...denied] })
      return { ...outcome, diagnostics: fresh(outcome.diagnostics) }
    },
    audit(input: AuditInput): AuditOutcome {
      const outcome = auditCommandList(input)
      for (const name of outcome.shadowed) denied.add(name)
      const held = new Set([...input.listed.map((entry) => entry.name), ...input.native.names])
      for (const name of [...denied]) {
        if (!held.has(name)) denied.delete(name)
      }
      return { ...outcome, diagnostics: fresh(outcome.diagnostics) }
    },
  }
}

function diagnosticKey(line: string): string {
  const separator = line.indexOf(": ")
  return separator === -1 ? line : `${line.slice(0, separator)}|${line.slice(separator + 2)}`
}
