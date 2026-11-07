import { compareText, type CommandEntry, type CommandSnapshotSet } from "./contracts.ts"
import type { CommandEditor, CommandInvocation } from "./plugin.ts"

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A published entry resolved from the live snapshot at invocation time (ADR command R14). */
export interface CommandTarget {
  readonly entry: CommandEntry
  readonly directory: string
}

export type CommandLookup = (name: string) => CommandTarget | undefined
export type CommandExecutor = (target: CommandTarget, invocation: CommandInvocation) => Promise<void>

export interface ApplyCommandOptions {
  readonly lookup: CommandLookup
  readonly execute?: CommandExecutor
}

export function findCommand(
  snapshot: CommandSnapshotSet | undefined,
  name: string,
): CommandTarget | undefined {
  if (snapshot === undefined) return undefined

  for (const record of snapshot.snapshots) {
    for (const entry of record.commands) {
      if (entry.name === name) return { entry, directory: record.directory }
    }
  }

  return undefined
}

/**
 * Add-only replay of the command snapshot (ADR command R14, R16; plan PD5, PD6, PD12).
 *
 * The editor has no remove: the host rebuild drops what is no longer replayed, so this
 * function only adds. It is synchronous, reads nothing, and catches per entry so one bad
 * definition never costs its siblings. `execute` resolves its entry from the live snapshot,
 * so a rebuild rebinding the closure sees the current content.
 */
export function applyCommands(
  editor: CommandEditor,
  snapshot: CommandSnapshotSet | undefined,
  { lookup, execute }: ApplyCommandOptions,
): readonly string[] {
  if (snapshot === undefined) return []

  const diagnostics: string[] = []
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const targets: CommandTarget[] = snapshot.snapshots
    .flatMap((record) => record.commands.map((entry) => ({ entry, directory: record.directory })))
    .sort(
      (left, right) =>
        compareText(left.entry.name, right.entry.name) || compareText(left.entry.canonicalPath, right.entry.canonicalPath),
    )

  const run = async (name: string, invocation: CommandInvocation): Promise<void> => {
    const target = lookup(name)
    if (target === undefined || execute === undefined) return
    await execute(target, invocation)
  }

  for (const target of targets) {
    const name = target.entry.name

    if (seen.has(name)) {
      if (!duplicates.has(name)) {
        duplicates.add(name)
        diagnostics.push(`command-duplicate: ${name}`)
      }
      continue
    }
    seen.add(name)

    try {
      editor.add({
        name,
        ...(target.entry.description === undefined ? {} : { description: target.entry.description }),
        execute: (invocation) => run(name, invocation),
      })
    } catch (error) {
      diagnostics.push(`command-replay: ${name}: ${reasonOf(error)}`)
    }
  }

  return diagnostics
}
