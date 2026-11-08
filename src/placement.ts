import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import type { JsonSchema } from "effect"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"

/**
 * Placement narrows the child to its destination, so the host stays cut down to the
 * domains placement needs: no permission surface is reachable from here (ADR-exposure-02 D1).
 */
export interface PlacementHost {
  readonly location: Pick<Plugin.Context["location"], "directory" | "project">
  readonly tool: Pick<Plugin.Context["tool"], "transform">
  readonly session: Pick<Plugin.Context["session"], "get" | "move">
  readonly worktree: Pick<Plugin.Context["worktree"], "list">
}

export interface Placement {
  activate(): Promise<void>
  dispose(): Promise<void>
  readonly diagnostics: readonly string[]
}

export const GUIDANCE = [
  "directory optionally places the child before this task is admitted, so the first request is assembled from that location.",
  "Absolute paths are used directly; relative paths resolve from the calling session's current directory and a leading ~ expands to the home directory.",
  "The destination must be inside this project or one of its worktrees.",
  "A placed child narrows to the destination's instructions, skills, same-id agents, config and permissions, and loses sibling subprojects.",
  "With sessionID a different directory moves the child again at the next boundary; history is preserved, but relative paths in it are not rewritten.",
  "A failed placement leaves the child created but unprompted and is not rolled back.",
].join("\n")

const DIRECTORY_PROPERTY: JsonSchema.JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    'Optional working directory for the child. Absolute, or relative to the calling session; a leading "~" expands to the home directory. The child moves before this task is admitted, so its first request runs there.',
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Effect codecs become JSON Schema; an already-JSON schema is only checked for shape. */
export function extendInput(input: unknown): JsonSchema.JsonSchema {
  const document = Schema.isSchema(input) ? Schema.toJsonSchemaDocument(input) : undefined
  const json = isObject(document)
    ? {
        ...document.schema,
        ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
      }
    : input
  if (!isObject(json) || json.type !== "object" || !isObject(json.properties)) {
    throw new Error("native subagent input is not an object schema")
  }
  if ("directory" in json.properties) throw new Error("native subagent input already declares directory")
  return {
    ...json,
    properties: { ...json.properties, directory: DIRECTORY_PROPERTY },
  } as JsonSchema.JsonSchema
}

export function extendDescription(description: string): string {
  return description.endsWith(GUIDANCE) ? description : `${description}\n\n${GUIDANCE}`
}

export type PlacementResolution =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly directory: string; readonly reason: string }
  | { readonly kind: "resolved"; readonly directory: string }

export interface ResolvePlacementInput {
  readonly directory: unknown
  readonly caller: string
  readonly home: string
}

/** Same expansion the host applies to a file read: `~`, `~/x`, then resolve against the caller. */
export async function resolvePlacement(input: ResolvePlacementInput): Promise<PlacementResolution> {
  const value = input.directory
  if (value === undefined || value === "") return { kind: "absent" }
  if (typeof value !== "string") {
    return { kind: "refused", directory: String(value), reason: "directory must be a string" }
  }
  if (value.trim() === "") return { kind: "refused", directory: value, reason: "directory is blank" }
  const expanded =
    value === "~" ? input.home : value.startsWith("~/") ? path.join(input.home, value.slice(2)) : value
  const directory = path.resolve(input.caller, expanded)

  try {
    const info = await stat(directory)
    if (!info.isDirectory()) return { kind: "refused", directory, reason: "not a directory" }
  } catch {
    return { kind: "refused", directory, reason: "directory does not exist" }
  }
  return { kind: "resolved", directory: await realpath(directory) }
}

export interface BoundaryInput {
  readonly destination: string
  readonly location: string
  readonly project: string
  readonly worktrees: readonly string[]
}

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** The set `FileAccess.resolve` treats as internal: the location, the project, its worktrees. */
export function withinBoundary(input: BoundaryInput): boolean {
  if (isInside(input.location, input.destination)) return true
  const root = path.parse(input.project).root
  if (input.project !== root && isInside(input.project, input.destination)) return true
  return input.worktrees.some((worktree) => isInside(worktree, input.destination))
}

export function createPlacement(host: PlacementHost): Placement {
  const diagnostics: string[] = []
  let registration: { dispose: () => Promise<void> | void } | undefined
  let disposed = false

  const skip = (reason: string): void => {
    const line = `placement: ${reason}`
    if (!diagnostics.includes(line)) diagnostics.push(line)
  }

  return {
    get diagnostics() {
      return diagnostics
    },

    async activate() {
      if (registration !== undefined || disposed) return
      try {
        registration = await host.tool.transform((editor) => {
          try {
            const native = editor.get("subagent")
            if (native === undefined) {
              skip("subagent tool is not registered")
              return
            }
            const input = extendInput(native.input)
            const description = extendDescription(native.description)
            editor.update("subagent", (tool) => {
              tool.input = input
              tool.description = description
            })
          } catch (error) {
            skip(reasonOf(error))
          }
        })
      } catch (error) {
        skip(`register: ${reasonOf(error)}`)
      }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      const current = registration
      registration = undefined
      try {
        await current?.dispose()
      } catch (error) {
        skip(`dispose: ${reasonOf(error)}`)
      }
    },
  }
}
