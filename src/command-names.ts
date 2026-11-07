/**
 * `<qualifier>:<command>` as the registry and invocation key (ADR command R1, R2; plan PD1–PD3).
 *
 * The location is never qualified, so an empty part contributes nothing instead of a
 * leading or trailing separator.
 */
export function composeCommandName(subproject: string, nativeName: string): string {
  const qualifier = normalisePart(subproject)
  const command = normalisePart(nativeName)

  if (qualifier.length === 0) return command
  if (command.length === 0) return qualifier

  return `${qualifier}:${command}`
}

function normalisePart(value: string): string {
  // R1 order: consume a literal `:` before `/` becomes the separator.
  return value
    .replace(/:/g, "-")
    .replace(/\//g, ":")
    .replace(/\s/g, "-")
    .replace(/[\u0000-\u001F]/g, "")
}
