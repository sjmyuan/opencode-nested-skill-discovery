import type { Plugin, Skill } from "@opencode/plugin"
import type { SkillEditor } from "../../src/plugin.ts"

type TransformCallback = (editor: SkillEditor) => void

export interface FakeContext {
  readonly ctx: Plugin.Context
  readonly transforms: readonly TransformCallback[]
  readonly disposeCalls: number
  readonly editor: SkillEditor
}

const NATIVE_PATH = "/tmp/native-skills/alpha/SKILL.md" as Skill.Info["path"]

export function nativeSkill(id: string): Skill.Info {
  return {
    id: id as Skill.ID,
    name: id as Skill.Name,
    path: NATIVE_PATH,
    content: `# ${id}`,
  }
}

export function fakeContext(seed: readonly Skill.Info[] = []): FakeContext {
  const entries: Skill.Info[] = seed.map((skill) => ({ ...skill }))
  const transforms: TransformCallback[] = []
  const counters = { dispose: 0 }

  const editor = {
    list: () => entries,
    get: (id: string) => entries.find((entry) => entry.id === id),
    add: (skill: Skill.Info) => {
      entries.push({ ...skill })
    },
    update: (id: string, update: (skill: Skill.Info) => void) => {
      const entry = entries.find((candidate) => candidate.id === id)
      if (entry !== undefined) update(entry)
    },
    remove: (id: string) => {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index >= 0) entries.splice(index, 1)
    },
  } as unknown as SkillEditor

  // Only the skill domain exists: any other host capability in setup is a loud failure.
  const ctx = {
    skill: {
      transform: async (callback: TransformCallback) => {
        transforms.push(callback)
        return {
          dispose: async () => {
            counters.dispose += 1
          },
        }
      },
    },
  } as unknown as Plugin.Context

  return {
    ctx,
    transforms,
    get disposeCalls() {
      return counters.dispose
    },
    editor,
  }
}
