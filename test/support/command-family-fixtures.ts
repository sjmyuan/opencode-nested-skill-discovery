import path from "node:path"
import type { CommandCandidate } from "../../src/contracts.ts"
import { scanSkills } from "../../src/scan.ts"
import type { FamilyWorkspace } from "./family-fixtures.ts"
import type { Workspace } from "./indexer-fixtures.ts"

export const commandDoc = (name: string): string =>
  `---\ndescription: ${name} command\n---\n# ${name}\n\n${name} body.\n`

/** Write one command file under `<checkout>/.opencode/<root>/<relName>` (PD1 of the command ADR). */
export async function writeCommand(
  ws: Workspace,
  checkout: string,
  root: "command" | "commands",
  relName: string,
): Promise<string> {
  return ws.write(path.posix.join(checkout, ".opencode", root, relName), commandDoc(relName.replace(/\.md$/, "")))
}

/** The same file with explicit frontmatter and body, for cases that need `agent`/`model`/`subagent`. */
export async function writeCommandDoc(
  ws: Workspace,
  checkout: string,
  root: "command" | "commands",
  relName: string,
  content: string,
): Promise<string> {
  return ws.write(path.posix.join(checkout, ".opencode", root, relName), content)
}

/** The real F1 candidates for a workspace root: no hand-built command objects in tests. */
export async function scanCommands(
  ws: FamilyWorkspace,
  location: string = ws.root,
): Promise<readonly CommandCandidate[]> {
  const scanned = await scanSkills({ location })
  return scanned.commands
}
