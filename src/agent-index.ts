import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { relative, sep } from "node:path"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Permission } from "@opencode/schema/permission"
import {
  CONFIG_DOCUMENT_ORDER,
  ID_PREFIX,
  MAX_AGENT_SLUG_LENGTH,
  type AgentCandidate,
  type AgentConfigCandidate,
  type AgentRootKind,
} from "./contracts.ts"
import { readConfigDocument, errorCode, type ConfigDocument } from "./agent-config.ts"
import { decodeAgentFile, type AgentFields } from "./agent-decode.ts"
import { filterAgentFamilies, type AgentFamilyEntry } from "./agent-family.ts"
import { createFamilyPass, type FamilyPass } from "./family.ts"
import { scopeTokenFor, slug } from "./indexer.ts"

/**
 * The agent index (ADR agent A6–A8, A11, A14; contract C4/C5 config arms).
 *
 * One entry per (subproject, native name) across both sources, merged in A8 order —
 * `opencode.json` < `opencode.jsonc` < `.opencode/opencode.json` < `.opencode/opencode.jsonc`
 * < agent files sorted — then family-filtered and minted as
 * `nested.<scopeToken>.<agentToken>`. The first source owns the token; a document decodes
 * as a unit, so a failed document contributes neither agents nor permissions.
 *
 * Nothing here registers, projects or reloads: the result is data for a later cell.
 */

export interface AgentSource {
  readonly kind: "file" | "config"
  /** A8 rank: a document's `CONFIG_DOCUMENT_ORDER` index, or 4 for every agent file. */
  readonly rank: number
  readonly path: string
  readonly canonicalPath: string
  readonly name: string
  readonly subproject: string
  readonly subprojectRealPath: string
  readonly fields: AgentFields
  readonly root?: AgentRootKind
}

export interface IndexedAgent extends AgentFields {
  readonly id: string
  /** The native name (the ADR's `nativeName`): the `agents` map key, or the file path name. */
  readonly name: string
  readonly canonicalPath: string
  readonly subproject: string
  readonly subprojectRealPath: string
  readonly source: "file" | "config"
  readonly root?: AgentRootKind
  readonly configKey?: string
  /** The subproject's top-level rules in A8 order, to be prefixed before the agent's own (G5). */
  readonly subprojectPermissions: readonly Permission.Rule[]
}

export interface IndexAgentsInput {
  readonly location: string
  readonly home: string
  readonly agents: readonly AgentCandidate[]
  readonly configs: readonly AgentConfigCandidate[]
  /** One family pass per refresh (A11); omit to derive privately. */
  readonly family?: FamilyPass
}

export interface IndexAgentsResult {
  readonly agents: readonly IndexedAgent[]
  readonly diagnostics: readonly string[]
}

const FILE_RANK = CONFIG_DOCUMENT_ORDER.length

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** The indexer's `hash8`, kept local so `src/indexer.ts` stays untouched. */
const hash8 = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8)

/**
 * A7: a file token hashes the file's realpath; a config token hashes the document's
 * realpath joined to the map key, so a same-name pair never collides.
 */
export function agentTokenFor(
  name: string,
  source:
    | { readonly kind: "file"; readonly realPath: string }
    | { readonly kind: "config"; readonly configRealPath: string; readonly key: string },
): string {
  const input = source.kind === "file" ? source.realPath : `${source.configRealPath}#${source.key}`
  return `${slug(name, MAX_AGENT_SLUG_LENGTH)}-${hash8(input)}`
}

interface Candidate extends AgentFamilyEntry {
  readonly name: string
  readonly owner: AgentSource
  readonly sources: readonly AgentSource[]
  readonly fields: AgentFields
  readonly subprojectPermissions: readonly Permission.Rule[]
  readonly root?: AgentRootKind
}

export async function indexAgents(input: IndexAgentsInput): Promise<IndexAgentsResult> {
  const { location } = input
  const diagnostics: string[] = []
  const display = (path: string): string => relative(location, path).split(sep).join("/")

  // A15: every filesystem and decode call is caught below, so this function never throws.
  const documents = new Map<string, ConfigDocument | undefined>()
  const documentPermissions = new Map<string, readonly Permission.Rule[]>()
  const sources: AgentSource[] = []

  for (const config of [...input.configs].sort(
    (left, right) =>
      compareText(left.subprojectRealPath, right.subprojectRealPath) ||
      CONFIG_DOCUMENT_ORDER.indexOf(left.document) - CONFIG_DOCUMENT_ORDER.indexOf(right.document),
  )) {
    let document = documents.get(config.canonicalPath)
    if (!documents.has(config.canonicalPath)) {
      const read = await readConfigDocument({
        path: config.path,
        canonicalPath: config.canonicalPath,
        home: input.home,
        display: display(config.path),
      }).catch((error: unknown) => ({
        document: undefined,
        diagnostics: [`agent-skip: unreadable ${display(config.path)}: ${errorCode(error)}`] as readonly string[],
      }))
      document = read.document
      diagnostics.push(...read.diagnostics)
      documents.set(config.canonicalPath, document)
    }
    if (document === undefined) continue

    // A14: the subproject's own documents contribute their top-level rules, in A8 order.
    const rank = CONFIG_DOCUMENT_ORDER.indexOf(config.document)
    const keys = documentPermissions.get(config.subprojectRealPath) ?? []
    documentPermissions.set(config.subprojectRealPath, [...keys, ...document.permissions])
    sources.push(...configSources(config, document, rank))
  }

  for (const agent of input.agents) {
    let text: string
    try {
      text = await readFile(agent.canonicalPath, "utf8")
    } catch (error) {
      diagnostics.push(`agent-skip: unreadable ${display(agent.path)}: ${errorCode(error)}`)
      continue
    }
    const decoded = decodeAgentFile(text, display(agent.path))
    if (!decoded.ok) {
      diagnostics.push(`agent-skip: ${decoded.reason} ${display(agent.path)}`)
      continue
    }
    diagnostics.push(...decoded.diagnostics)
    sources.push({
      kind: "file",
      rank: FILE_RANK,
      path: agent.path,
      canonicalPath: agent.canonicalPath,
      name: agent.name,
      subproject: agent.subproject,
      subprojectRealPath: agent.subprojectRealPath,
      fields: decoded.fields,
      root: agent.root,
    })
  }

  const merged: Candidate[] = []
  for (const group of groupByName(sources)) {
    const ordered = orderBySource(group)
    const ownerSource = ordered[0] as AgentSource
    const subprojectPermissions = documentPermissions.get(ownerSource.subprojectRealPath) ?? []
    merged.push({
      name: ownerSource.name,
      canonicalPath: ownerSource.canonicalPath,
      path: ownerSource.path,
      subproject: ownerSource.subproject,
      subprojectRealPath: ownerSource.subprojectRealPath,
      owner: ownerSource,
      sources: ordered,
      fields: mergeFields(ordered),
      subprojectPermissions,
      ...(ownerSource.root === undefined ? {} : { root: ownerSource.root }),
    })
    if (ordered.length > 1) {
      diagnostics.push(`agent-merge: ${ownerSource.name} (${ordered.map((source) => display(source.path)).join(" + ")})`)
    }
  }

  const family = input.family ?? (await createFamilyPass(location))
  const filtered = await filterAgentFamilies(merged, { family })
  diagnostics.push(...filtered.diagnostics)

  return {
    agents: filtered.agents
      .map((candidate) => indexOne(candidate))
      .sort((left, right) => compareText(left.id, right.id)),
    diagnostics: [...diagnostics].sort(compareText),
  }
}

function configSources(
  config: AgentConfigCandidate,
  document: ConfigDocument,
  rank: number,
): readonly AgentSource[] {
  return [...document.agents.entries()].map(([key, item]) => ({
    kind: "config",
    rank,
    path: config.path,
    canonicalPath: config.canonicalPath,
    name: key,
    subproject: config.subproject,
    subprojectRealPath: config.subprojectRealPath,
    fields: fieldsFromConfig(item),
  }))
}

/** A `ConfigAgent.Info` class instance never leaves this boundary. */
function fieldsFromConfig(item: ConfigAgent.Info): AgentFields {
  const request = item.request
  return {
    ...(item.system === undefined ? {} : { system: item.system }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.model === undefined
      ? {}
      : {
          model: {
            providerID: item.model.providerID,
            id: item.model.model,
            ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
          },
        }),
    ...(item.mode === undefined ? {} : { mode: item.mode }),
    ...(item.hidden === undefined ? {} : { hidden: item.hidden }),
    ...(item.color === undefined ? {} : { color: item.color }),
    ...(item.steps === undefined ? {} : { steps: item.steps }),
    ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
    ...(item.permissions === undefined
      ? {}
      : {
          permissions: item.permissions.map((rule) => ({
            action: rule.action,
            resource: rule.resource,
            effect: rule.effect,
          })),
        }),
    ...(request === undefined
      ? {}
      : { request: { headers: { ...(request.headers ?? {}) }, body: { ...(request.body ?? {}) } } }),
  }
}

/** One group per (subproject, native name): the only key A8 merges on. */
function groupByName(sources: readonly AgentSource[]): readonly (readonly AgentSource[])[] {
  const groups = new Map<string, AgentSource[]>()
  for (const source of sources) {
    const key = `${source.subprojectRealPath}\u0000${source.name}`
    const group = groups.get(key) ?? []
    group.push(source)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** A8: documents by rank, files after them and ordered by path. */
function orderBySource(group: readonly AgentSource[]): readonly AgentSource[] {
  return [...group].sort((left, right) => left.rank - right.rank || compareText(left.path, right.path))
}

/**
 * A8 field semantics: a later source overrides a field it sets and never erases one it
 * omits; `permissions` append in source order; `request` assigns per key.
 */
function mergeFields(sources: readonly AgentSource[]): AgentFields {
  let merged: AgentFields = {}
  for (const source of sources) {
    const fields = source.fields
    merged = {
      ...merged,
      ...(fields.system === undefined ? {} : { system: fields.system }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.model === undefined ? {} : { model: fields.model }),
      ...(fields.mode === undefined ? {} : { mode: fields.mode }),
      ...(fields.hidden === undefined ? {} : { hidden: fields.hidden }),
      ...(fields.color === undefined ? {} : { color: fields.color }),
      ...(fields.steps === undefined ? {} : { steps: fields.steps }),
      ...(fields.disabled === undefined ? {} : { disabled: fields.disabled }),
      ...(fields.permissions === undefined
        ? {}
        : { permissions: [...(merged.permissions ?? []), ...fields.permissions] }),
      ...(fields.request === undefined
        ? {}
        : {
            request: {
              headers: { ...(merged.request?.headers ?? {}), ...fields.request.headers },
              body: { ...(merged.request?.body ?? {}), ...fields.request.body },
            },
          }),
    }
  }
  return merged
}

function indexOne(candidate: Candidate): IndexedAgent {
  const owner = candidate.owner
  const token =
    owner.kind === "file"
      ? agentTokenFor(candidate.name, { kind: "file", realPath: owner.canonicalPath })
      : agentTokenFor(candidate.name, {
          kind: "config",
          configRealPath: owner.canonicalPath,
          key: candidate.name,
        })

  return {
    ...candidate.fields,
    id: `${ID_PREFIX}${scopeTokenFor(candidate.subprojectRealPath)}.${token}`,
    name: candidate.name,
    canonicalPath: owner.canonicalPath,
    subproject: owner.subproject,
    subprojectRealPath: owner.subprojectRealPath,
    source: owner.kind,
    ...(candidate.root === undefined ? {} : { root: candidate.root }),
    ...(owner.kind === "config" ? { configKey: candidate.name } : {}),
    subprojectPermissions: candidate.subprojectPermissions,
  }
}
