import { MAX_NAME_LENGTH } from "./contracts.ts"

const MARKUP = /[<>"&]/g
const WHITESPACE_RUN = /\s+/g
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
const TRAILING_WHITESPACE = /\s+$/
const PATH_PREFIX = "…/"
const ELLIPSIS = "…"

const length = (value: string): number => Array.from(value).length

function cutTo(value: string, budget: number): string {
  if (budget <= 1) return ELLIPSIS

  return `${Array.from(value).slice(0, budget - 1).join("")}${ELLIPSIS}`
}

export function composeName(
  relativeSubprojectPath: string,
  nativeName: string,
  maxLength: number = MAX_NAME_LENGTH,
): string {
  const relative = relativeSubprojectPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/")
  const base = relative.length > 0 ? `${relative}/${nativeName}` : nativeName

  return sanitizeText(truncateName(base, maxLength), maxLength)
}

export function truncateName(name: string, maxLength: number = MAX_NAME_LENGTH): string {
  if (length(name) <= maxLength) return name

  const segments = name.split("/").filter((segment) => segment.length > 0)

  if (segments.length <= 1) return cutTo(name, maxLength)

  for (let keep = segments.length - 1; keep >= 1; keep -= 1) {
    const candidate = `${PATH_PREFIX}${segments.slice(segments.length - keep).join("/")}`

    if (length(candidate) <= maxLength) return candidate
  }

  return `${PATH_PREFIX}${cutTo(segments.at(-1) ?? "", maxLength - 2)}`
}

export function sanitizeText(input: string, maxLength: number): string {
  const plain = input.replace(MARKUP, "").replace(WHITESPACE_RUN, " ")
  const withoutControl = plain.replace(CONTROL, "")
  const normalized = withoutControl.replace(WHITESPACE_RUN, " ").trim()
  const capped = Array.from(normalized).slice(0, maxLength).join("")

  return capped.replace(TRAILING_WHITESPACE, "")
}
