/**
 * Throttled prompt backstop (F6 PD6, ADR R16/R17).
 *
 * A non-recursive watcher set cannot see into a directory created after the watch
 * was armed (ADR Q1), so a prompt admission re-scans when no refresh has completed
 * inside the window. The callback is total: `session.*` hooks have no failure
 * channel, so a throw or rejection here would break prompt admission.
 */

export interface Backstop {
  prompt(): Promise<void>
  observe(at: number): void
  dispose(): Promise<void>
}

export interface CreateBackstopInput {
  readonly refresh: () => Promise<unknown>
  readonly inFlight: () => Promise<unknown> | undefined
  readonly throttleMs: number
  readonly now: () => number
}

export function createBackstop({ refresh, inFlight, throttleMs, now }: CreateBackstopInput): Backstop {
  let lastAt = Number.NEGATIVE_INFINITY
  let disposed = false

  return {
    async prompt() {
      if (disposed) return

      try {
        const running = inFlight()
        if (running !== undefined) {
          // One in-flight scan is the ceiling: the prompt waits for it and starts nothing new.
          await Promise.resolve(running).catch(() => undefined)
          return
        }

        const at = now()
        if (at - lastAt < throttleMs) return
        lastAt = at
        await refresh()
      } catch {
        // Total by contract: a failed backstop refresh (or clock) is the registry's diagnostic to report.
      }
    },
    observe(at) {
      lastAt = at
    },
    async dispose() {
      disposed = true
    },
  }
}
