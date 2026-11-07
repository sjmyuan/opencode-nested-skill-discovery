import { spawn } from "node:child_process"

/**
 * Shell seam for command expansion (ADR R10, plan PD7): a pure `{env, platform}` →
 * `{file, family}` resolution, the family's argv shape, and the injectable runner
 * that is the expander's only route to a process.
 */

export type ShellFamily = "posix" | "cmd" | "powershell"

export interface ShellTarget {
  readonly file: string
  readonly family: ShellFamily
}

export interface ShellRun {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
}

export type ProcessOutcome =
  | { readonly kind: "ran"; readonly exitCode: number; readonly output: string }
  | { readonly kind: "failed"; readonly message: string }

export type ProcessRunner = (run: ShellRun) => Promise<ProcessOutcome>

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Last path segment, accepting both separators, lowercased, without a trailing `.exe`. */
function baseName(file: string): string {
  const normalized = file.replaceAll("\\", "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  return name.toLowerCase().replace(/\.exe$/, "")
}

/**
 * Family from the interpreter's own name. An unrecognized `SHELL` is treated as a
 * POSIX shell; an unrecognized `COMSPEC` keeps the cmd behaviour the OS declared.
 */
function familyOf(file: string, fallback: ShellFamily): ShellFamily {
  const name = baseName(file)
  if (name === "cmd") return "cmd"
  if (name === "powershell" || name === "pwsh") return "powershell"
  return fallback
}

function configured(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]
  if (value === undefined || value.trim() === "") return undefined
  return value
}

/**
 * PD7 table: `SHELL` first; on win32 `COMSPEC` and then `cmd.exe`; on darwin
 * `/bin/zsh`; elsewhere `/bin/sh`. No PATH scan, no new dependency.
 */
export function resolveShell(input: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: string
}): ShellTarget {
  const shell = configured(input.env, "SHELL")
  if (shell !== undefined) return { file: shell, family: familyOf(shell, "posix") }

  if (input.platform === "win32") {
    const comspec = configured(input.env, "COMSPEC")
    if (comspec !== undefined) return { file: comspec, family: familyOf(comspec, "cmd") }
    return { file: "cmd.exe", family: "cmd" }
  }

  if (input.platform === "darwin") return { file: "/bin/zsh", family: "posix" }
  return { file: "/bin/sh", family: "posix" }
}

/** Native argv shapes (`packages/core/src/shell/select.ts:168-176`). */
export function shellArgs(target: ShellTarget, command: string): readonly string[] {
  if (target.family === "cmd") return ["/c", command]
  if (target.family === "powershell") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  }
  return ["-c", command]
}

/**
 * Production runner (PD5/PD6): stdin ignored, stdout and stderr concatenated in
 * arrival order, no timeout, `cwd` supplied by the caller. Any exit code is `ran` —
 * `AppProcess.run` does not fail on a non-zero exit either. Only a spawn error is
 * `failed`, and the promise never rejects.
 */
export const nodeProcessRunner: ProcessRunner = (run) =>
  new Promise<ProcessOutcome>((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (outcome: ProcessOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    let child
    try {
      child = spawn(run.file, [...run.args], {
        cwd: run.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      finish({ kind: "failed", message: reasonOf(error) })
      return
    }

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.on("error", (error) => finish({ kind: "failed", message: reasonOf(error) }))
    child.on("close", (code) =>
      finish({ kind: "ran", exitCode: code ?? 0, output: Buffer.concat(chunks).toString("utf8") }),
    )
  })
