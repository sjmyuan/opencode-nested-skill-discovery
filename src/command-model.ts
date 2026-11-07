/**
 * The single place the stored `model` string and the routing `Model.Ref` meet
 * (plan PD12, PD15; ADR command N3/N4).
 *
 * The snapshot keeps a plain string — `src/contracts.ts`, `src/manifest.ts` and the
 * stored cache signature are byte-identical — and only the executor parses it back.
 * The grammar is the pinned schema's: `providerID/model#variant?`, split on the first
 * `/` and the first `#`, with an id that may itself contain slashes.
 */

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export type ModelSelection =
  | string
  | { readonly providerID: string; readonly model: string; readonly variant?: string }

export const SUBAGENT_PREFIX = "You are a subagent spawned by another session."

const reject = (): undefined => undefined

/** Split `providerID/model#variant`, rejecting every shape the pinned pattern rejects. */
function parseShortForm(value: string): ModelRef | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0) return reject()

  const providerID = value.slice(0, slash)
  const rest = value.slice(slash + 1)
  if (providerID.includes("#") || rest === "") return reject()

  const hash = rest.indexOf("#")
  if (hash < 0) return { providerID, id: rest }

  const id = rest.slice(0, hash)
  const variant = rest.slice(hash + 1)
  if (id === "" || variant === "" || variant.includes("#")) return reject()

  return { providerID, id, variant }
}

/** A mapping is valid when its three scalars fit the short form's constraints. */
function parseMapping(selection: {
  readonly providerID: string
  readonly model: string
  readonly variant?: string
}): ModelRef | undefined {
  const { providerID, model, variant } = selection
  if (providerID === "" || providerID.includes("/") || providerID.includes("#")) return reject()
  if (model === "" || model.includes("#")) return reject()
  if (variant !== undefined && (variant === "" || variant.includes("#"))) return reject()

  return { providerID, id: model, ...(variant === undefined ? {} : { variant }) }
}

/** Both accepted forms to the canonical short string, or `undefined` when invalid. */
export function canonicalModelSelection(selection: ModelSelection): string | undefined {
  const ref = typeof selection === "string" ? parseShortForm(selection) : parseMapping(selection)
  if (ref === undefined) return undefined

  return ref.variant === undefined ? `${ref.providerID}/${ref.id}` : `${ref.providerID}/${ref.id}#${ref.variant}`
}

/** The canonical short string back to the `Model.Ref` shape the host switches to. */
export function modelRefOf(value: string): ModelRef | undefined {
  return parseShortForm(value)
}
