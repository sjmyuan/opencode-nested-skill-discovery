import type { NativeCommandNameIndex } from "./command-native.ts"
import type { AuditOutcome, ListedCommand, PublishedCommand, ShadowTracker } from "./command-shadow.ts"
import type { CommandSnapshotSet } from "./contracts.ts"

/** No native walk ran, so nothing is known to be native-owned. */
export const EMPTY_NATIVE_COMMANDS: NativeCommandNameIndex = Object.freeze({
  names: Object.freeze([]),
  complete: true,
  diagnostics: Object.freeze([]),
})

/** The replayed snapshot is the published set (ADR command R4): never the pre-drop candidates. */
export function publishedCommands(snapshot: CommandSnapshotSet): readonly PublishedCommand[] {
  return snapshot.snapshots.flatMap((record) => record.commands)
}

export interface AuditReloadInput {
  readonly snapshot: CommandSnapshotSet
  readonly list: () => Promise<{ readonly data: readonly ListedCommand[] }>
  readonly native: NativeCommandNameIndex
  readonly tracker: ShadowTracker
}

/**
 * Classifies one `command.list()` against the snapshot it just replayed (ADR command R4).
 *
 * A rejection propagates: the caller's stage guard owns isolation, so a failed listing
 * becomes one diagnostic instead of a silent pass.
 */
export async function auditReloadedCommands({
  snapshot,
  list,
  native,
  tracker,
}: AuditReloadInput): Promise<AuditOutcome> {
  const { data } = await list()
  return tracker.audit({ listed: data, published: publishedCommands(snapshot), native })
}
