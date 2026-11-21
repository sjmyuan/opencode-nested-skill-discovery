import type { Agent, Skill } from "@opencode/plugin"
import type { AdmittedAgent } from "./agent-project.ts"
import { compareText, type RegistryEntry, type RegistrySnapshot } from "./contracts.ts"
import type { AgentEditor, SkillEditor } from "./plugin.ts"

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function toInfo(entry: RegistryEntry): Skill.Info {
  return {
    id: entry.id as Skill.ID,
    name: entry.name as Skill.Name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.autoinvoke === undefined ? {} : { autoinvoke: entry.autoinvoke }),
    path: entry.canonicalPath as Skill.Info["path"],
    content: entry.content,
  }
}

export function applyRegistry(
  editor: SkillEditor,
  snapshot: RegistrySnapshot | undefined,
): readonly string[] {
  if (snapshot === undefined) return []

  const diagnostics: string[] = []
  const entries = snapshot.snapshots
    .flatMap((subproject) => subproject.skills)
    .sort((left, right) => compareText(left.id, right.id))

  for (const entry of entries) {
    try {
      if (editor.get(entry.id) !== undefined) continue
    } catch (error) {
      diagnostics.push(`replay: ${entry.id}: ${reasonOf(error)}`)
      continue
    }

    try {
      editor.add(toInfo(entry))
    } catch (error) {
      diagnostics.push(`replay: ${entry.id}: ${reasonOf(error)}`)
    }
  }

  return diagnostics
}

/** The pre-registration listing's `mode`/`hidden` per ID; a `nested.` ID is never in it (G4). */
export type ModeSeed = ReadonlyMap<
  string,
  { readonly mode: "subagent" | "primary" | "all"; readonly hidden: boolean }
>

/**
 * Insert-on-miss replay of the agent payload (ADR agent G1, G4, G8).
 *
 * `update` is the only write: the host seeds a missing ID with `Agent.Info.default` and the
 * config plugin appends the location's rules after every transform, so our rules must go last
 * among ours and the parent's stay later still. An ID the map already returns is left alone —
 * native and config entries are never overwritten — and neither `default` nor `remove` is ever
 * called. Verification runs per entry, so one bad row never costs its siblings. A source that
 * authors neither `mode` nor `hidden` inherits the pair of the same-named entry the seed carries.
 */
export function applyAgents(
  editor: AgentEditor,
  agents: readonly AdmittedAgent[] | undefined,
  seed: ModeSeed,
): readonly string[] {
  if (agents === undefined) return []

  const diagnostics: string[] = []
  const seen = new Set<string>()
  const entries = [...agents].sort((left, right) => compareText(left.id, right.id))

  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)

    try {
      if (editor.get(entry.id) !== undefined) continue
    } catch (error) {
      diagnostics.push(`agent-replay: ${entry.id}: ${reasonOf(error)}`)
      continue
    }

    try {
      editor.update(entry.id, (agent) => {
        agent.name = entry.name as Agent.Name
        if (entry.description !== undefined) agent.description = entry.description
        if (entry.system !== undefined) agent.system = entry.system
        if (entry.model !== undefined)
          agent.model = {
            id: entry.model.id,
            providerID: entry.model.providerID,
            ...(entry.model.variant === undefined ? {} : { variant: entry.model.variant }),
          } as Agent.Info["model"]
        if (entry.steps !== undefined) agent.steps = entry.steps as Agent.Info["steps"]
        // G4: a source that authors neither inherits the pair of the same-named entry the
        // pre-registration seed carries; an authored value still wins.
        const inherited = seed.get(entry.nativeName)
        const mode = entry.mode ?? inherited?.mode
        const hidden = entry.hidden ?? inherited?.hidden
        if (mode !== undefined) agent.mode = mode
        if (hidden !== undefined) agent.hidden = hidden
        agent.permissions.push(...entry.permissions)
        Object.assign(agent.request.headers, entry.request.headers)
        Object.assign(agent.request.body, entry.request.body)
      })
    } catch (error) {
      diagnostics.push(`agent-replay: ${entry.id}: ${reasonOf(error)}`)
    }
  }

  return diagnostics
}
