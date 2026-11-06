import { MAX_NAME_LENGTH } from "./contracts.ts"

const MARKUP = /[<>"&]/g
const WHITESPACE_RUN = /\s+/g
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
const TRAILING_WHITESPACE = /\s+$/

export function composeName(
  _relativeSubprojectPath: string,
  _nativeName: string,
  _maxLength: number = MAX_NAME_LENGTH,
): string {
  throw new Error("not implemented")
}

export function truncateName(_name: string, _maxLength: number = MAX_NAME_LENGTH): string {
  throw new Error("not implemented")
}

export function sanitizeText(input: string, maxLength: number): string {
  const plain = input.replace(MARKUP, "").replace(WHITESPACE_RUN, " ")
  const withoutControl = plain.replace(CONTROL, "")
  const normalized = withoutControl.replace(WHITESPACE_RUN, " ").trim()
  const capped = Array.from(normalized).slice(0, maxLength).join("")

  return capped.replace(TRAILING_WHITESPACE, "")
}
