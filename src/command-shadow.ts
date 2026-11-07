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
