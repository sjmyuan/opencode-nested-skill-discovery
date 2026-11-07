import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createWorkspace, doc, type Workspace } from "./indexer-fixtures.ts"

export interface FamilyWorkspace extends Workspace {
  mkdirp(relativePath: string): Promise<string>
  repo(relativePath: string): Promise<string>
  worktree(relativePath: string, common: string, name: string): Promise<string>
}

export async function createFamilyWorkspace(): Promise<FamilyWorkspace> {
  const base = await createWorkspace()
  const absolute = (relativePath: string): string => path.join(base.root, relativePath)

  return {
    ...base,
    mkdirp: async (relativePath) => {
      const directory = absolute(relativePath)
      await mkdir(directory, { recursive: true })
      return directory
    },
    repo: async (relativePath) => {
      const git = absolute(path.join(relativePath, ".git"))
      await mkdir(path.join(git, "worktrees"), { recursive: true })
      return git
    },
    worktree: async (relativePath, common, name) => {
      const gitdir = absolute(path.join(common, ".git", "worktrees", name))
      await mkdir(gitdir, { recursive: true })
      return base.write(path.join(relativePath, ".git"), `gitdir: ${gitdir}\n`)
    },
  }
}

export const skillDoc = (name: string): string =>
  doc(`name: ${name}\ndescription: ${name} skill`, `# ${name}\n\n${name} body.\n`)

export async function checkoutSkill(
  ws: Workspace,
  checkout: string,
  slug: string,
  name = slug,
): Promise<string> {
  return ws.write(path.posix.join(checkout, ".opencode", "skills", slug, "SKILL.md"), skillDoc(name))
}
