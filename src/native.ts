import { realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { compareText } from "./contracts.ts"

export interface NativeRootInput {
  readonly location: string
  readonly home: string
  readonly configDirectory: string
}

const CONFIG_DIRECTORIES = [".opencode", ".claude", ".agents"] as const
const SKILL_DIRECTORIES = ["skill", "skills"] as const
const AGENT_DIRECTORIES = ["agent", "agents"] as const

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

/**
 * Native agent roots (ADR agent A5): `<ancestor>/.opencode/{agent,agents}` for every
 * ancestor of the location, plus `<config directory>/{agent,agents}`. `.claude` and
 * `.agents` are deliberately absent — A4 keeps them out of the agent source set.
 */
export function nativeAgentRootCandidates({ location, configDirectory }: NativeRootInput): readonly string[] {
  const scoped = ancestorsOf(location).map((directory) => join(directory, ".opencode"))
  return [configDirectory, ...scoped].flatMap((directory) =>
    AGENT_DIRECTORIES.map((leaf) => join(directory, leaf)),
  )
}

/** Canonicalises, dedupes, sorts, and skips every root that does not exist. */
export async function resolveNativeRoots(input: NativeRootInput): Promise<readonly string[]> {
  return resolveAll(nativeRootCandidates(input))
}

/** The same canonicalisation for the agent roots; one rule, two source sets. */
export async function resolveNativeAgentRoots(input: NativeRootInput): Promise<readonly string[]> {
  return resolveAll(nativeAgentRootCandidates(input))
}

async function resolveAll(candidates: readonly string[]): Promise<readonly string[]> {
  const resolved = new Set<string>()

  for (const candidate of candidates) {
    try {
      resolved.add(await realpath(candidate))
    } catch {
      continue
    }
  }

  return [...resolved].sort(compareText)
}
