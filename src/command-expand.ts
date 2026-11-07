/**
 * Native-parity command template expansion (ADR R9/R10/R11, plan PD3–PD6).
 *
 * The five native steps are immovable: tokenise → `$N` (the highest index absorbs the
 * tail) → `$ARGUMENTS` (raw) → append when no placeholder → trim → shell. The text
 * half is pure; the shell pass reaches the process world only through the injected
 * `ProcessRunner`, never throws, and never adds a final trim.
 */

import { shellArgs } from "./command-shell.ts"
import type { ProcessOutcome, ProcessRunner, ShellTarget } from "./command-shell.ts"

const ARGUMENT_PATTERN = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const PLACEHOLDER_PATTERN = /\$(\d+)/g
const QUOTE_TRIM_PATTERN = /^["']|["']$/g
const SHELL_PATTERN = /!`([^`]+)`/g

/** The native tokenizer (`packages/core/src/config/plugin/command.ts:242-244`). */
export function tokenizeArguments(text: string): readonly string[] {
  return (text.match(ARGUMENT_PATTERN) ?? []).map((argument) =>
    argument.replace(QUOTE_TRIM_PATTERN, ""),
  )
}

export interface ExpandShell {
  readonly target: ShellTarget
  readonly cwd: string
  readonly run: ProcessRunner
}

export interface ExpandInput {
  readonly template: string
  readonly args: string
  readonly shell: ExpandShell
}

export interface ExpandResult {
  readonly text: string
  readonly diagnostics: readonly string[]
  readonly shellFailed: boolean
}

/**
 * Highest `$N` index ≥ 1. `$0` is out of range by decision (PD4, ADR Q6) and never
 * participates in the tail-absorption computation.
 */
function highestPlaceholder(placeholders: readonly string[]): number {
  let highest = 0
  for (const placeholder of placeholders) {
    const index = Number(placeholder.slice(1))
    if (index >= 1 && index > highest) highest = index
  }
  return highest
}

export async function expandCommand(input: ExpandInput): Promise<ExpandResult> {
  const args = tokenizeArguments(input.args)
  const placeholders = input.template.match(PLACEHOLDER_PATTERN) ?? []
  const highest = highestPlaceholder(placeholders)

  const expanded = input.template.replaceAll(PLACEHOLDER_PATTERN, (_match, index: string) => {
    const position = Number(index)
    if (position === 0) return ""
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === highest) return args.slice(argIndex).join(" ")
    return args[argIndex] ?? ""
  })

  const withArguments = expanded.replaceAll("$ARGUMENTS", () => input.args)
  const append =
    placeholders.length === 0 &&
    !input.template.includes("$ARGUMENTS") &&
    input.args.trim().length > 0
  const text = append
    ? `${withArguments}\n\n${input.args}`.trim()
    : withArguments.trim()

  return interpolate(text, input.shell)
}

interface ShellOutcome {
  readonly output: string
  readonly diagnostic?: string
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * One `` !`cmd` ``: a `ran` outcome substitutes its combined output with no diagnostic
 * (a non-zero exit is not a failure — `AppProcess.run` does not fail on it either);
 * a `failed` outcome, a synchronous throw and a rejection all become the same
 * diagnostic and an empty substitution.
 */
async function runShell(shell: ExpandShell, source: string): Promise<ShellOutcome> {
  const diagnostic = (message: string): ShellOutcome => ({
    output: "",
    diagnostic: `Shell interpolation failed for ${JSON.stringify(source)}: ${message}`,
  })

  let outcome: ProcessOutcome
  try {
    outcome = await shell.run({
      file: shell.target.file,
      args: shellArgs(shell.target, source),
      cwd: shell.cwd,
    })
  } catch (error) {
    return diagnostic(reasonOf(error))
  }

  if (outcome.kind === "failed") return diagnostic(outcome.message)
  return { output: outcome.output }
}

/**
 * PD5/PD6: every match in match order, concurrency 2, substitution by index through a
 * function replacer so `$&`/`$$` inside shell output stay literal. Diagnostics are
 * collected by index, so their order never depends on settle order.
 */
async function interpolate(text: string, shell: ExpandShell): Promise<ExpandResult> {
  const matches = Array.from(text.matchAll(SHELL_PATTERN))
  if (matches.length === 0) {
    return { text, diagnostics: [], shellFailed: false }
  }

  const outcomes: (ShellOutcome | undefined)[] = new Array(matches.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= matches.length) return
      const source = matches[index]?.[1] ?? ""
      outcomes[index] = await runShell(shell, source)
    }
  }
  await Promise.all([worker(), worker()])

  const resolved: ShellOutcome[] = outcomes.map((outcome) => outcome ?? { output: "" })
  const diagnostics: string[] = []
  for (const outcome of resolved) {
    if (outcome.diagnostic !== undefined) diagnostics.push(outcome.diagnostic)
  }

  let position = 0
  const expanded = text.replace(SHELL_PATTERN, () => resolved[position++]?.output ?? "")

  return { text: expanded, diagnostics, shellFailed: diagnostics.length > 0 }
}
