import { readFile } from "node:fs/promises"
import { relative, sep } from "node:path"
import type { QualifiedCommand } from "./command-names.ts"
import {
  DEFAULT_SCAN_LIMITS,
  compareText,
  type CommandEntry,
  type CommandSnapshot,
  type CommandSnapshotSet,
} from "./contracts.ts"
import { parseCommandFrontmatter } from "./frontmatter.ts"
import { scopeTokenFor } from "./indexer.ts"

export interface BuildCommandSnapshotInput {
  readonly location: string
  readonly commands: readonly QualifiedCommand[]
  readonly maxFileBytes?: number
}

export interface BuildCommandSnapshotResult {
  readonly snapshot: CommandSnapshotSet
  readonly diagnostics: readonly string[]
}

/**
 * The immutable command snapshot for one refresh (ADR command R16; plan PD1, PD7).
 *
 * Content is read here, not by the scan: a file can grow or vanish between the two, so
 * the byte budget is re-checked and a bad sibling is dropped without costing the rest.
 * Records and entries are frozen and sorted, so the snapshot never depends on scan order.
 */
export async function buildCommandSnapshot({
  location,
  commands,
  maxFileBytes = DEFAULT_SCAN_LIMITS.maxFileBytes,
}: BuildCommandSnapshotInput): Promise<BuildCommandSnapshotResult> {
  const groups = new Map<string, { readonly directory: string; readonly entries: CommandEntry[] }>()
  const diagnostics: string[] = []

  for (const command of commands) {
    const entry = await readEntry(command, location, maxFileBytes, diagnostics)
    if (entry === undefined) continue

    const scopeToken = scopeTokenFor(command.subprojectRealPath)
    const group = groups.get(scopeToken) ?? { directory: command.subprojectRealPath, entries: [] }
    group.entries.push(entry)
    groups.set(scopeToken, group)
  }

  const snapshots: readonly CommandSnapshot[] = Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([scopeToken, group]) =>
        Object.freeze({
          scopeToken,
          directory: group.directory,
          commands: Object.freeze(
            [...group.entries]
              .sort((left, right) => compareText(left.name, right.name))
              .map((entry) => Object.freeze(entry)),
          ),
        }),
      ),
  )

  return {
    snapshot: Object.freeze({ location, snapshots }),
    diagnostics: Object.freeze([...new Set(diagnostics)].sort(compareText)),
  }
}

async function readEntry(
  command: QualifiedCommand,
  location: string,
  maxFileBytes: number,
  diagnostics: string[],
): Promise<CommandEntry | undefined> {
  const rel = relativeTo(location, command.path)

  let text: string
  try {
    text = await readFile(command.canonicalPath, "utf8")
  } catch (error) {
    diagnostics.push(`unreadable: ${rel} (${errorCode(error)})`)
    return undefined
  }

  if (Buffer.byteLength(text, "utf8") > maxFileBytes) {
    diagnostics.push(`command-oversize: ${rel}`)
    return undefined
  }

  const parsed = parseCommandFrontmatter(text, rel)
  if (!parsed.ok) {
    diagnostics.push(`command-frontmatter: ${rel}: ${parsed.reason}`)
    return undefined
  }

  const { description, agent, model, subagent } = parsed.frontmatter

  return {
    name: command.publishedName,
    canonicalPath: command.canonicalPath,
    ...(description === undefined ? {} : { description }),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(subagent === undefined ? {} : { subagent }),
    template: parsed.template,
  }
}

function relativeTo(location: string, path: string): string {
  const rel = relative(location, path)
  if (rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`)) return rel.split(sep).join("/")
  return path
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "UNKNOWN"
}
