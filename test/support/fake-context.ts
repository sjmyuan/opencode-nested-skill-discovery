import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, Skill } from "@opencode/plugin"
import type { Schema } from "effect"
import type { SkillEditor } from "../../src/plugin.ts"

type TransformCallback = (editor: SkillEditor) => void
type HookCallback = (input: unknown) => Promise<void> | void

export type FailureTarget =
  | "skill.transform"
  | "skill.reload"
  | "skill.list"
  | "session.hook"
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "storage.scan"

export interface FakeLocation {
  directory: string
  readonly project: {
    readonly id: string
    directory: string
    canonical: string
  }
}

export interface FakeStorageScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

export interface FakeContextOptions {
  readonly directory?: string
  readonly storage?: Iterable<readonly [string, Schema.Json]>
  readonly onReload?: () => void
}

export interface FakeContext {
  readonly ctx: Plugin.Context
  readonly transforms: readonly TransformCallback[]
  readonly disposeCalls: number
  readonly hookRegistrations: number
  readonly hookDisposeCalls: number
  readonly editor: SkillEditor
  readonly location: FakeLocation
  readonly storage: Map<string, Schema.Json>
  readonly reloadCalls: number
  onReload: (() => void) | undefined
  setLocation(directory: string): void
  hideNatives(reads: number): void
  addNative(skill: Skill.Info): void
  removeNative(id: string): void
  fail(target: FailureTarget, error?: unknown): void
  failKey(key: string, error?: unknown): void
  clearFailures(): void
  firePrompt(): Promise<void>
}

const NATIVE_PATH = "/tmp/native-skills/alpha/SKILL.md" as Skill.Info["path"]
const DEFAULT_SCAN_LIMIT = 100

export function nativeSkill(id: string, path?: string): Skill.Info {
  return {
    id: id as Skill.ID,
    name: id as Skill.Name,
    path: (path ?? NATIVE_PATH) as Skill.Info["path"],
    content: `# ${id}`,
  }
}

export function fakeContext(seed: readonly Skill.Info[] = [], options: FakeContextOptions = {}): FakeContext {
  const natives: Skill.Info[] = seed.map((skill) => ({ ...skill }))
  let entries: Skill.Info[] = natives.map((skill) => ({ ...skill }))
  let hiddenListReads = 0
  const transforms: TransformCallback[] = []
  const counters = { dispose: 0, reload: 0, hookRegistrations: 0, hookDisposals: 0 }
  const hookRegistry = new Map<string, HookCallback[]>()
  const failures = new Map<FailureTarget, unknown>()
  const keyFailures = new Map<string, unknown>()
  const values = new Map<string, Schema.Json>(options.storage ?? [])
  const hooks: { onReload: (() => void) | undefined } = { onReload: options.onReload }
  const directory = options.directory ?? realpathSync(mkdtempSync(join(tmpdir(), "nested-fake-")))
  const location: FakeLocation = {
    directory,
    project: { id: "project-fake", directory, canonical: directory },
  }

  const guarded = async <T>(target: FailureTarget, run: () => T | Promise<T>): Promise<T> => {
    if (failures.has(target)) throw failures.get(target)
    return run()
  }

  const guardKey = (key: string): void => {
    if (keyFailures.has(key)) throw keyFailures.get(key)
  }

  const page = ({ prefix, after, limit = DEFAULT_SCAN_LIMIT }: FakeStorageScanOptions) => {
    const keys = [...values.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort()
    const visible = keys.slice(0, limit)
    const next = keys.length > visible.length ? visible[visible.length - 1] : undefined

    return {
      entries: visible.map((key) => ({ key, value: values.get(key) as Schema.Json })),
      ...(next === undefined ? {} : { next }),
    }
  }

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

  // Only the four faked domains exist: any other host capability in setup is a loud failure.
  const ctx = {
    skill: {
      transform: async (callback: TransformCallback) =>
        guarded("skill.transform", () => {
          transforms.push(callback)
          return {
            dispose: async () => {
              counters.dispose += 1
            },
          }
        }),
      reload: async () =>
        guarded("skill.reload", () => {
          entries = natives.map((skill) => ({ ...skill }))
          for (const transform of transforms) transform(editor)
          hooks.onReload?.()
          counters.reload += 1
        }),
      list: async () =>
        guarded("skill.list", () => {
          const data =
            hiddenListReads > 0
              ? entries.filter((entry) => String(entry.id).startsWith("nested."))
              : entries
          if (hiddenListReads > 0) hiddenListReads -= 1
          return { location: { directory: location.directory }, data }
        }),
    },
    location,
    session: {
      hook: async (name: string, callback: HookCallback) =>
        guarded("session.hook", () => {
          const registered = hookRegistry.get(name) ?? []
          registered.push(callback)
          hookRegistry.set(name, registered)
          counters.hookRegistrations += 1
          return {
            dispose: async () => {
              counters.hookDisposals += 1
            },
          }
        }),
    },
    storage: {
      get: async (key: string) =>
        guarded("storage.get", () => {
          guardKey(key)
          return values.get(key)
        }),
      set: async (key: string, value: Schema.Json) =>
        guarded("storage.set", () => {
          guardKey(key)
          values.set(key, value)
        }),
      remove: async (key: string) =>
        guarded("storage.remove", () => {
          guardKey(key)
          values.delete(key)
        }),
      scan: async (options: FakeStorageScanOptions) => guarded("storage.scan", () => page(options)),
    },
  } as unknown as Plugin.Context

  return {
    ctx,
    transforms,
    editor,
    location,
    storage: values,
    get disposeCalls() {
      return counters.dispose
    },
    get hookRegistrations() {
      return counters.hookRegistrations
    },
    get hookDisposeCalls() {
      return counters.hookDisposals
    },
    get reloadCalls() {
      return counters.reload
    },
    get onReload() {
      return hooks.onReload
    },
    set onReload(value) {
      hooks.onReload = value
    },
    setLocation(next: string) {
      location.directory = next
      location.project.directory = next
      location.project.canonical = next
    },
    hideNatives(reads: number) {
      hiddenListReads = reads
    },
    addNative(skill: Skill.Info) {
      natives.push({ ...skill })
    },
    removeNative(id: string) {
      const index = natives.findIndex((skill) => skill.id === id)
      if (index >= 0) natives.splice(index, 1)
    },
    fail(target: FailureTarget, error: unknown = new Error(target)) {
      failures.set(target, error)
    },
    failKey(key: string, error: unknown = new Error(`key ${key}`)) {
      keyFailures.set(key, error)
    },
    clearFailures() {
      failures.clear()
      keyFailures.clear()
    },
    // Surfaces rejections on purpose: a "never rejects" test must be able to fail loudly.
    async firePrompt() {
      for (const callback of hookRegistry.get("prompt") ?? []) {
        await callback({})
      }
    },
  }
}
