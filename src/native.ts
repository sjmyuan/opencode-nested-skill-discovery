import { realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export interface NativeRootInput {
  readonly location: string
  readonly home: string
  readonly configDirectory: string
}

const CONFIG_DIRECTORIES = [".opencode", ".claude", ".agents"] as const
const SKILL_DIRECTORIES = ["skill", "skills"] as const

const comparePath = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

function ancestorsOf(location: string): readonly string[] {
  const ancestors: string[] = []
  let current = resolve(location)
  for (;;) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) return ancestors
    current = parent
  }
}

const expand = (directories: readonly string[]): readonly string[] =>
  directories.flatMap((directory) => SKILL_DIRECTORIES.map((leaf) => join(directory, leaf)))

export function nativeRootCandidates({ location, home, configDirectory }: NativeRootInput): readonly string[] {
  const scoped = ancestorsOf(location).flatMap((directory) =>
    CONFIG_DIRECTORIES.map((name) => join(directory, name)),
  )
  const global = [configDirectory, join(home, ".claude"), join(home, ".agents")]

  return expand([...scoped, ...global])
}

export async function resolveNativeRoots(input: NativeRootInput): Promise<readonly string[]> {
  const resolved = new Set<string>()

  for (const candidate of nativeRootCandidates(input)) {
    try {
      resolved.add(await realpath(candidate))
    } catch {
      continue
    }
  }

  return [...resolved].sort(comparePath)
}
