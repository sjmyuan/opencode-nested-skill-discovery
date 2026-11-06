import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"

export interface Scaffold {
  readonly root: string
  readonly realRoot: string
  cleanup(): Promise<void>
}

export interface ScanFixture extends Scaffold {
  write(rel: string, content?: string): Promise<string>
  mkdir(rel: string): Promise<string>
  symlink(rel: string, target: string): Promise<string>
  siblings(suffix: string): Promise<string>
  rel(abs: string): string
  chmod(rel: string, mode: number): Promise<void>
}

async function makeScaffold(prefix: string): Promise<Scaffold> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const realRoot = await realpath(root)
  return {
    root,
    realRoot,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Temp-directory fixture rooted in mkdtemp. `root` is the raw path; `realRoot`
 * is its canonical form (on macOS `/var/...` resolves to `/private/var/...`),
 * so every path assertion must use `realRoot`.
 */
export async function createFixture(): Promise<ScanFixture> {
  const scaffold = await makeScaffold("nested-scan-")
  const chmodded: string[] = []
  const extras: string[] = []

  return {
    root: scaffold.root,
    realRoot: scaffold.realRoot,
    async write(rel, content = "---\nname: x\n---\n") {
      const abs = join(scaffold.root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
      return abs
    },
    async mkdir(rel) {
      const abs = join(scaffold.root, rel)
      await mkdir(abs, { recursive: true })
      return abs
    },
    async symlink(rel, target) {
      const abs = join(scaffold.root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await symlink(target, abs)
      return abs
    },
    async siblings(suffix) {
      const dir = `${scaffold.root}${suffix}`
      await mkdir(dir, { recursive: true })
      extras.push(dir)
      return dir
    },
    rel(abs) {
      return relative(scaffold.realRoot, abs).split(sep).join("/")
    },
    async chmod(rel, mode) {
      const abs = join(scaffold.root, rel)
      await chmod(abs, mode)
      chmodded.push(abs)
    },
    async cleanup() {
      for (const abs of chmodded) {
        await chmod(abs, 0o755).catch(() => undefined)
      }
      for (const extra of extras) {
        await rm(extra, { recursive: true, force: true, maxRetries: 2 })
      }
      await scaffold.cleanup()
    },
  }
}

/** An independent temp directory, for symlink targets outside the scanned location. */
export async function createOutside(): Promise<Scaffold & { write(rel: string, content?: string): Promise<string> }> {
  const scaffold = await makeScaffold("nested-scan-outside-")
  return {
    ...scaffold,
    async write(rel, content = "outside\n") {
      const abs = join(scaffold.root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
      return abs
    },
  }
}
