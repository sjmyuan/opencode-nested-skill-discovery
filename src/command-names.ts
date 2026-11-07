/**
 * `<qualifier>:<command>` as the registry and invocation key (ADR command R1, R2; plan PD1–PD3).
 *
 * The location is never qualified, so an empty part contributes nothing instead of a
 * leading or trailing separator.
 */
export function composeCommandName(subproject: string, nativeName: string): string {
  const qualifier = part(subproject)
  const command = part(nativeName)

  if (qualifier.length === 0) return command
  if (command.length === 0) return qualifier

  return `${qualifier}:${command}`
}

function part(value: string): string {
  return value.replace(/\//g, ":")
}
