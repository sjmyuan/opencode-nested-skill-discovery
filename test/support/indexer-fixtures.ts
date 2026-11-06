import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ScanCandidate, SkillRootKind } from "../../src/contracts.ts"

const ROOT_MARKERS: ReadonlyArray<readonly [string, SkillRootKind]> = [
  [".opencode/skills", "opencode-skills"],
  [".opencode/skill", "opencode-skill"],
  [".agents/skills", "agents-skills"],
  [".claude/skills", "claude-skills"],
]

export interface Workspace {
  readonly root: string
  write(relativePath: string, content: string): Promise<string>
  link(relativePath: string, target: string): Promise<string>
  candidate(relativePath: string, subproject?: string): Promise<ScanCandidate>
  cleanup(): Promise<void>
}

export function only<T>(items: readonly T[]): T {
  if (items.length !== 1) throw new Error(`expected exactly one item, got ${items.length}`)
  return items[0] as T
}

export function doc(frontmatter: string, body = "# Deploy\n\nDeploys releases.\n"): string {
  return `---\n${frontmatter}\n---\n${body}`
}

export async function createWorkspace(): Promise<Workspace> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nested-indexer-")))

  const write = async (relativePath: string, content: string): Promise<string> => {
    const absolute = path.join(root, relativePath)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, content, "utf8")
    return absolute
  }

  const kindOf = (relativePath: string): SkillRootKind => {
    const normalized = relativePath.split(path.sep).join("/")
    const marker = ROOT_MARKERS.find(([suffix]) => normalized.includes(`/${suffix}/`))
    if (marker === undefined) throw new Error(`no skill root marker in ${relativePath}`)
    return marker[1]
  }

  return {
    root,
    write,
    link: async (relativePath, target) => {
      const absolute = path.join(root, relativePath)
      await mkdir(path.dirname(absolute), { recursive: true })
      await symlink(target, absolute)
      return absolute
    },
    candidate: async (relativePath, subproject = "") => {
      const absolute = path.join(root, relativePath)
      return {
        path: absolute,
        realPath: await realpath(absolute),
        subproject,
        root: kindOf(relativePath),
        markers: [kindOf(relativePath)],
      }
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}
