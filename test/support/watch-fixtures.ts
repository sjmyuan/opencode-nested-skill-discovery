/**
 * Structural mirror of `WatchFactory` (`src/watch.ts`). Kept local so this support
 * module typechecks before the production module exists; the shapes are identical,
 * so a `FakeWatch["factory"]` is assignable wherever a `WatchFactory` is expected.
 */
export type FakeWatchFactory = (directory: string, onChange: () => void) => { close(): void }

export interface FakeWatch {
  readonly factory: FakeWatchFactory
  /** Every directory the factory was asked to watch, in call order. */
  readonly opened: readonly string[]
  /** Every directory whose handle was closed, in call order. */
  readonly closed: readonly string[]
  active(): readonly string[]
  emit(directory?: string): void
  failOn(directory: string, error?: unknown): void
}

/**
 * Recording `WatchFactory` double: never touches `fs.watch`, so no test depends on
 * real filesystem event timing. `emit()` drives the stored callbacks directly.
 */
export function fakeWatch(): FakeWatch {
  const opened: string[] = []
  const closed: string[] = []
  const callbacks = new Map<string, () => void>()
  const failures = new Map<string, unknown>()

  const factory: FakeWatchFactory = (directory, onChange) => {
    if (failures.has(directory)) throw failures.get(directory)
    opened.push(directory)
    callbacks.set(directory, onChange)
    return {
      close: () => {
        closed.push(directory)
        callbacks.delete(directory)
      },
    }
  }

  return {
    factory,
    opened,
    closed,
    active() {
      return [...callbacks.keys()].sort()
    },
    emit(directory) {
      if (directory !== undefined) {
        callbacks.get(directory)?.()
        return
      }
      for (const callback of [...callbacks.values()]) callback()
    },
    failOn(directory, error = Object.assign(new Error(directory), { code: "EACCES" })) {
      failures.set(directory, error)
    },
  }
}
