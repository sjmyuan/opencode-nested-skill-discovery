/**
 * Structural mirror of the command-expander process seam (`src/command-shell.ts`).
 * Kept local so this support module typechecks before the production module exists;
 * the shapes are identical, so a `FakeRunner["run"]` is assignable wherever a
 * `ProcessRunner` is expected and a `FakeShellTarget` wherever a `ShellTarget` is.
 */

export interface FakeShellRun {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
}

export type FakeOutcome =
  | { readonly kind: "ran"; readonly exitCode: number; readonly output: string }
  | { readonly kind: "failed"; readonly message: string }

export interface FakeShellTarget {
  readonly file: string
  readonly family: "posix" | "cmd" | "powershell"
}

export interface PendingCall {
  readonly index: number
  readonly run: FakeShellRun
  resolve(outcome?: FakeOutcome): void
  reject(error?: unknown): void
}

export interface FakeRunner {
  readonly run: (run: FakeShellRun) => Promise<FakeOutcome>
  /** Every call, in launch order, claimed by the runner. */
  readonly calls: readonly FakeShellRun[]
  /** Highest number of calls that were open at the same time. */
  readonly maxInFlight: number
  /** Calls that have not settled yet, in launch order. */
  pending(): readonly PendingCall[]
  /** Settle the call launched at `calls[index]`. */
  resolve(index: number, outcome: FakeOutcome): void
  /** Reject the call launched at `calls[index]`. */
  reject(index: number, error?: unknown): void
}

export const ran = (output: string, exitCode = 0): FakeOutcome => ({
  kind: "ran",
  exitCode,
  output,
})

export const failed = (message: string): FakeOutcome => ({ kind: "failed", message })

const settleWith = (outcome: FakeOutcome | undefined): FakeOutcome =>
  outcome ?? { kind: "ran", exitCode: 0, output: "" }

/**
 * Recording `ProcessRunner` double. Every call stays open until the test settles it
 * through `resolve(index, …)` or `reject(index, …)`, so concurrency can be held open
 * deterministically. `scriptedRunner` is the same recorder with outcomes settled from
 * a script in call order.
 */
export function fakeRunner(): FakeRunner {
  return createRunner()
}

export function scriptedRunner(outcomes: readonly FakeOutcome[]): FakeRunner {
  return createRunner((index) => outcomes[index])
}

function createRunner(script?: (index: number) => FakeOutcome | undefined): FakeRunner {
  const calls: FakeShellRun[] = []
  const open = new Map<number, PendingCall>()
  let inFlight = 0
  let peak = 0

  const run = (call: FakeShellRun): Promise<FakeOutcome> => {
    const index = calls.length
    calls.push(call)
    inFlight += 1
    peak = Math.max(peak, inFlight)

    return new Promise<FakeOutcome>((resolve, reject) => {
      let done = false
      const settle = (): boolean => {
        if (done) return false
        done = true
        open.delete(index)
        inFlight -= 1
        return true
      }

      const handle: PendingCall = {
        index,
        run: call,
        resolve: (outcome) => {
          if (settle()) resolve(settleWith(outcome))
        },
        reject: (error) => {
          if (settle()) reject(error ?? new Error(`spawn ${call.file} ENOENT`))
        },
      }

      open.set(index, handle)
      if (script !== undefined) handle.resolve(script(index))
    })
  }

  return {
    run,
    calls,
    get maxInFlight() {
      return peak
    },
    pending() {
      return [...open.values()]
    },
    resolve(index, outcome) {
      open.get(index)?.resolve(outcome)
    },
    reject(index, error) {
      open.get(index)?.reject(error)
    },
  }
}

export const posixTarget = (file = "/bin/zsh"): FakeShellTarget => ({ file, family: "posix" })
export const cmdTarget = (file = "cmd.exe"): FakeShellTarget => ({ file, family: "cmd" })
export const powershellTarget = (file = "pwsh"): FakeShellTarget => ({
  file,
  family: "powershell",
})
