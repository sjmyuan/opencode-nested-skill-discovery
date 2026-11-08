import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, Skill } from "@opencode/plugin"
import type { Schema } from "effect"
import type { CommandEditor, SkillEditor } from "../../src/plugin.ts"

type TransformCallback = (editor: SkillEditor) => void
type CommandTransformCallback = (editor: CommandEditor) => void
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
type ToolTransformCallback = (editor: ToolEditor) => void
type HookCallback = (input: unknown) => Promise<void> | void

export interface FakeToolContext {
  readonly sessionID: string
  readonly signal: AbortSignal
  readonly progress: (update: Record<string, unknown>) => Promise<void>
}

export type FakeToolExecute = (input: unknown, context: FakeToolContext) => Promise<unknown>

export interface FakeToolSeed {
  readonly id: string
  readonly description?: string
  readonly input?: unknown
  readonly execute?: FakeToolExecute
}

export interface CommandSeed {
  readonly name: string
  readonly description?: string
}

export interface FakeCommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: unknown) => Promise<void>
}

export type FailureTarget =
  | "skill.transform"
  | "skill.reload"
  | "skill.list"
  | "command.transform"
  | "command.reload"
  | "command.list"
  | "session.hook"
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "storage.scan"

export type SyncFailureTarget = "command.transform" | "skill.transform"

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

export interface FakeModelRef {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface FakeAgentSeed {
  readonly id: string
  readonly mode?: "subagent" | "primary" | "all"
  readonly model?: FakeModelRef
}

export interface FakeSessionSeed {
  readonly id: string
  readonly agent?: string
  readonly model?: FakeModelRef
}

export type SessionOperation = "get" | "create" | "switchAgent" | "switchModel" | "prompt"

export interface FakePromptCall {
  readonly sessionID: string
  readonly text: string
  readonly input: Record<string, unknown>
}

export interface FakeSwitchCall {
  readonly kind: "agent" | "model"
  readonly sessionID: string
  readonly value: unknown
}

export interface FakeContextOptions {
  readonly directory?: string
  readonly storage?: Iterable<readonly [string, Schema.Json]>
  /** Share one store across instances, as the plugin-id-namespaced host storage does. */
  readonly storageMap?: Map<string, Schema.Json>
  readonly onReload?: () => void
  readonly commands?: readonly CommandSeed[]
  readonly nativeCommands?: readonly CommandSeed[]
  readonly onCommandReload?: () => void
  readonly agents?: readonly FakeAgentSeed[]
  readonly sessions?: readonly FakeSessionSeed[]
  readonly tools?: readonly FakeToolSeed[]
}

export interface FakeContext {
  readonly ctx: Plugin.Context
  readonly transforms: readonly TransformCallback[]
  readonly disposeCalls: number
  readonly hookRegistrations: number
  readonly hookDisposeCalls: number
  readonly editor: SkillEditor
  readonly commandTransforms: readonly CommandTransformCallback[]
  readonly commandDefinitions: readonly FakeCommandDefinition[]
  readonly toolTransforms: readonly ToolTransformCallback[]
  readonly toolDisposeCalls: number
  readonly toolReloadCalls: number
  tool(id: string): Record<string, unknown> | undefined
  readonly location: FakeLocation
  readonly storage: Map<string, Schema.Json>
  readonly reloadCalls: number
  readonly commandReloadCalls: number
  readonly commandDisposeCalls: number
  readonly commandListCalls: number
  readonly sessionCalls: readonly SessionOperation[]
  readonly agentCalls: readonly string[]
  readonly childSessions: readonly Record<string, unknown>[]
  readonly prompts: readonly FakePromptCall[]
  readonly switches: readonly FakeSwitchCall[]
  onReload: (() => void) | undefined
  onCommandReload: (() => void) | undefined
  setLocation(directory: string): void
  setNativeCommands(commands: readonly CommandSeed[]): void
  hideNatives(reads: number, keep?: readonly string[]): void
  addNative(skill: Skill.Info): void
  removeNative(id: string): void
  fail(target: FailureTarget, error?: unknown): void
  failSync(target: SyncFailureTarget, error?: unknown): void
  failKey(key: string, error?: unknown): void
  failCommandAdd(name: string, error?: unknown): void
  failSession(operation: SessionOperation, error?: unknown): void
  clearFailures(): void
  firePrompt(): Promise<void>
  invokeCommand(name: string, input?: unknown): Promise<void>
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
  let hiddenKeep: ReadonlySet<string> = new Set()
  const transforms: TransformCallback[] = []
  const commandTransforms: CommandTransformCallback[] = []
  const counters = { dispose: 0, reload: 0, hookRegistrations: 0, hookDisposals: 0, commandReload: 0, commandDispose: 0, commandList: 0, toolDispose: 0, toolReload: 0 }
  const hookRegistry = new Map<string, HookCallback[]>()
  const failures = new Map<FailureTarget, unknown>()
  const syncFailures = new Map<SyncFailureTarget, unknown>()
  const keyFailures = new Map<string, unknown>()
  const commandAddFailures = new Map<string, unknown>()
  const agents = new Map<string, FakeAgentSeed>((options.agents ?? []).map((agent) => [agent.id, { ...agent }]))
  const sessions = new Map<string, Record<string, unknown>>()
  for (const session of options.sessions ?? []) sessions.set(session.id, { ...session })
  const sessionCalls: SessionOperation[] = []
  const agentCalls: string[] = []
  const childSessions: Record<string, unknown>[] = []
  const prompts: FakePromptCall[] = []
  const switches: FakeSwitchCall[] = []
  const sessionFailures = new Map<SessionOperation, unknown>()
  let generatedChildren = 0
  const values = options.storageMap ?? new Map<string, Schema.Json>(options.storage ?? [])
  const hooks: { onReload: (() => void) | undefined; onCommandReload: (() => void) | undefined } = {
    onReload: options.onReload,
    onCommandReload: options.onCommandReload,
  }
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

  const guardedSession = async <T>(operation: SessionOperation, run: () => T | Promise<T>): Promise<T> => {
    sessionCalls.push(operation)
    if (sessionFailures.has(operation)) throw sessionFailures.get(operation)
    return run()
  }

  const agentInfo = (seed: FakeAgentSeed) => ({
    id: seed.id,
    name: seed.id,
    mode: seed.mode ?? "primary",
    hidden: false,
    request: {},
    permissions: [],
    ...(seed.model === undefined ? {} : { model: seed.model }),
  })

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

  const commandSeeds: readonly FakeCommandDefinition[] = (options.commands ?? []).map((seed) => ({
    name: seed.name,
    ...(seed.description === undefined ? {} : { description: seed.description }),
    execute: async () => undefined,
  }))
  let commandEntries = new Map<string, FakeCommandDefinition>()
  const resetCommands = (): void => {
    commandEntries = new Map(commandSeeds.map((entry) => [entry.name, { ...entry }]))
  }
  resetCommands()

  // Registered after the transform replay, the order the host's config plugin uses.
  let nativeCommandSeeds: readonly CommandSeed[] = options.nativeCommands ?? []
  const applyNativeCommands = (): void => {
    for (const seed of nativeCommandSeeds) {
      commandEntries.set(seed.name, {
        name: seed.name,
        ...(seed.description === undefined ? {} : { description: seed.description }),
        execute: async () => undefined,
      })
    }
  }

  const commandEditor = {
    add: (definition: FakeCommandDefinition) => {
      const failure = commandAddFailures.get(definition.name)
      if (failure !== undefined) throw failure
      commandEntries.set(definition.name, { ...definition })
    },
  } as unknown as CommandEditor

  const toolTransforms: ToolTransformCallback[] = []
  const toolSeeds = (options.tools ?? []).map((seed) => ({ ...seed }))
  let tools = new Map<string, Record<string, unknown>>()
  const toolEditor = {
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    namespace: () => undefined,
    add: (tool: Record<string, unknown>) => {
      tools.set(String(tool.id), { ...tool })
    },
    update: (id: string, update: (tool: Record<string, unknown>) => void) => {
      const current = tools.get(id)
      if (current === undefined) return
      const tool = { ...current }
      update(tool)
      tool.name = current.name
      tool.id = id
      tools.set(id, tool)
    },
    remove: (id: string) => {
      tools.delete(id)
    },
  } as unknown as ToolEditor

  // Host semantics: the tool state is rebuilt from its registrations on every replay.
  const replayTools = (): void => {
    tools = new Map(toolSeeds.map((seed) => [seed.id, { name: seed.id, ...seed }]))
    for (const transform of toolTransforms) transform(toolEditor)
  }

  // Only the faked domains exist: any other host capability in setup is a loud failure.
  const ctx = {
    skill: {
      transform: (callback: TransformCallback) => {
        const sync = syncFailures.get("skill.transform")
        if (sync !== undefined) throw sync
        return guarded("skill.transform", () => {
          transforms.push(callback)
          return {
            dispose: async () => {
              counters.dispose += 1
            },
          }
        })
      },
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
              ? entries.filter(
                  (entry) => String(entry.id).startsWith("nested.") || hiddenKeep.has(String(entry.id)),
                )
              : entries
          if (hiddenListReads > 0) hiddenListReads -= 1
          return { location: { directory: location.directory }, data }
        }),
    },
    command: {
      transform: (callback: CommandTransformCallback) => {
        const sync = syncFailures.get("command.transform")
        if (sync !== undefined) throw sync
        return guarded("command.transform", () => {
          commandTransforms.push(callback)
          return {
            dispose: async () => {
              counters.commandDispose += 1
            },
          }
        })
      },
      reload: async () =>
        guarded("command.reload", () => {
          resetCommands()
          for (const transform of commandTransforms) transform(commandEditor)
          applyNativeCommands()
          hooks.onCommandReload?.()
          counters.commandReload += 1
        }),
      list: async () => {
        counters.commandList += 1
        return guarded("command.list", () => ({
          location: { directory: location.directory },
          data: [...commandEntries.values()].map(({ name, description }) => ({
            name,
            ...(description === undefined ? {} : { description }),
          })),
        }))
      },
    },
    agent: {
      get: async (input: { agentID: string }) => {
        agentCalls.push("get")
        const seed = agents.get(input.agentID)
        if (seed === undefined) throw new Error(`unknown agent ${input.agentID}`)
        return { location: { directory: location.directory }, data: agentInfo(seed) }
      },
      list: async () => {
        agentCalls.push("list")
        return {
          location: { directory: location.directory },
          data: [...agents.values()].map((seed) => agentInfo(seed)),
        }
      },
    },
    location,
    tool: {
      transform: (callback: ToolTransformCallback) => {
        toolTransforms.push(callback)
        replayTools()
        return {
          dispose: async () => {
            counters.toolDispose += 1
          },
        }
      },
      reload: async () => {
        counters.toolReload += 1
        replayTools()
      },
      list: async () => [...tools.values()],
      hook: async () => ({
        dispose: async () => undefined,
      }),
    },
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
      get: async (input: { sessionID: string }) =>
        guardedSession("get", () => {
          const existing = sessions.get(input.sessionID)
          if (existing !== undefined) return existing
          const created = { id: input.sessionID }
          sessions.set(input.sessionID, created)
          return created
        }),
      create: async (input: Record<string, unknown>) =>
        guardedSession("create", () => {
          generatedChildren += 1
          const created = { ...input, id: `child-${generatedChildren}` }
          childSessions.push({ ...input })
          sessions.set(String(created.id), created)
          return created
        }),
      switchAgent: async (input: { sessionID: string; agent: string }) =>
        guardedSession("switchAgent", () => {
          switches.push({ kind: "agent", sessionID: input.sessionID, value: input.agent })
          const session = sessions.get(input.sessionID)
          if (session !== undefined) session.agent = input.agent
        }),
      switchModel: async (input: { sessionID: string; model: FakeModelRef }) =>
        guardedSession("switchModel", () => {
          switches.push({ kind: "model", sessionID: input.sessionID, value: input.model })
          const session = sessions.get(input.sessionID)
          if (session !== undefined) session.model = input.model
        }),
      prompt: async (input: { sessionID: string; text: string } & Record<string, unknown>) =>
        guardedSession("prompt", () => {
          prompts.push({ sessionID: input.sessionID, text: input.text, input: { ...input } })
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
    commandTransforms,
    location,
    storage: values,
    get disposeCalls() {
      return counters.dispose
    },
    get commandReloadCalls() {
      return counters.commandReload
    },
    get commandDisposeCalls() {
      return counters.commandDispose
    },
    get commandListCalls() {
      return counters.commandList
    },
    get sessionCalls() {
      return sessionCalls
    },
    get agentCalls() {
      return agentCalls
    },
    get childSessions() {
      return childSessions
    },
    get prompts() {
      return prompts
    },
    get switches() {
      return switches
    },
    get commandDefinitions() {
      return [...commandEntries.values()]
    },
    get toolTransforms() {
      return toolTransforms
    },
    get toolDisposeCalls() {
      return counters.toolDispose
    },
    get toolReloadCalls() {
      return counters.toolReload
    },
    tool(id: string) {
      return tools.get(id)
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
    get onCommandReload() {
      return hooks.onCommandReload
    },
    set onCommandReload(value) {
      hooks.onCommandReload = value
    },
    setLocation(next: string) {
      location.directory = next
      location.project.directory = next
      location.project.canonical = next
    },
    setNativeCommands(commands: readonly CommandSeed[]) {
      nativeCommandSeeds = commands.map((seed) => ({ ...seed }))
    },
    hideNatives(reads: number, keep: readonly string[] = []) {
      hiddenListReads = reads
      hiddenKeep = new Set(keep)
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
    failSync(target: SyncFailureTarget, error: unknown = new Error(target)) {
      syncFailures.set(target, error)
    },
    failKey(key: string, error: unknown = new Error(`key ${key}`)) {
      keyFailures.set(key, error)
    },
    failCommandAdd(name: string, error: unknown = new Error(`command ${name}`)) {
      commandAddFailures.set(name, error)
    },
    failSession(operation: SessionOperation, error: unknown = new Error(operation)) {
      sessionFailures.set(operation, error)
    },
    clearFailures() {
      failures.clear()
      syncFailures.clear()
      keyFailures.clear()
      commandAddFailures.clear()
      sessionFailures.clear()
    },
    // Surfaces rejections on purpose: a "never rejects" test must be able to fail loudly.
    async firePrompt() {
      for (const callback of hookRegistry.get("prompt") ?? []) {
        await callback({})
      }
    },
    async invokeCommand(name: string, input: unknown = {}) {
      const entry = commandEntries.get(name)
      if (entry === undefined) return
      await entry.execute(input)
    },
  }
}
