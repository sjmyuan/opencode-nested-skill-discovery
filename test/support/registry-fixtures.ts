import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { IndexedSkill } from "../../src/indexer.ts"

export function indexedSkill(overrides: Partial<IndexedSkill> = {}): IndexedSkill {
  return {
    id: "nested.scope.deploy-00000000",
    canonicalPath: "/tmp/root/.opencode/skills/deploy/SKILL.md",
    subproject: "",
    nativeName: "deploy",
    description: "Deploys releases.",
    content: "# Deploy\n\nDeploys releases.\n",
    ...overrides,
  }
}

export interface RegistryFixture {
  readonly root: string
  readonly realRoot: string
  write(rel: string, content?: string): Promise<string>
  mkdirp(rel: string): Promise<string>
  realpathOf(rel: string): Promise<string>
  cleanup(): Promise<void>
}

export async function createRegistryFixture(): Promise<RegistryFixture> {
  const root = await mkdtemp(join(tmpdir(), "nested-registry-"))
  const realRoot = await realpath(root)
  const absolute = (rel: string): string => join(root, rel)

  return {
    root,
    realRoot,
    async write(rel, content = "") {
      const path = absolute(rel)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
      return path
    },
    async mkdirp(rel) {
      const path = absolute(rel)
      await mkdir(path, { recursive: true })
      return path
    },
    async realpathOf(rel) {
      return realpath(absolute(rel))
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}
