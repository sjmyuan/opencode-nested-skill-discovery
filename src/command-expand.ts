/**
 * Native-parity command template expansion (ADR R9/R10/R11, plan PD3/PD4).
 *
 * The five native steps are immovable: tokenise → `$N` (the highest index absorbs the
 * tail) → `$ARGUMENTS` (raw) → append when no placeholder → trim → shell. This module
 * owns the text half in Step 3; the shell pass lands in Step 5.
 */

const ARGUMENT_PATTERN = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const PLACEHOLDER_PATTERN = /\$(\d+)/g
const QUOTE_TRIM_PATTERN = /^["']|["']$/g

/** The native tokenizer (`packages/core/src/config/plugin/command.ts:242-244`). */
export function tokenizeArguments(text: string): readonly string[] {
  return (text.match(ARGUMENT_PATTERN) ?? []).map((argument) =>
    argument.replace(QUOTE_TRIM_PATTERN, ""),
  )
}

/**
 * Structural mirror of the shell seam (`src/command-shell.ts`), kept local until the
 * shell pass lands so the text pipeline typechecks on its own.
 */
export interface ExpandShellTarget {
  readonly file: string
  readonly family: "posix" | "cmd" | "powershell"
}

export interface ExpandShellRun {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
}

export type ExpandProcessOutcome =
  | { readonly kind: "ran"; readonly exitCode: number; readonly output: string }
  | { readonly kind: "failed"; readonly message: string }

export type ExpandProcessRunner = (run: ExpandShellRun) => Promise<ExpandProcessOutcome>

export interface ExpandShell {
  readonly target: ExpandShellTarget
  readonly cwd: string
  readonly run: ExpandProcessRunner
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

  return { text, diagnostics: [], shellFailed: false }
}
