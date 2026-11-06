export interface Frontmatter {
  readonly name?: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly disableModelInvocation?: boolean
}

export type FrontmatterResult =
  | {
      readonly ok: true
      readonly frontmatter: Frontmatter
      readonly body: string
      readonly diagnostics: readonly string[]
    }
  | { readonly ok: false; readonly reason: string }

const FENCE = "---"
const SCALAR_KEYS = new Set(["name", "description", "disable-model-invocation"])

const indentOf = (line: string): number => line.length - line.trimStart().length

const unquote = (value: string): string => {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  return quoted ? value.slice(1, -1) : value
}

const booleanValue = (value: string): boolean | undefined => {
  const normalized = unquote(value).trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

const isUnsupported = (value: string): boolean => /^[[{&*]/.test(value)

const readBlockScalar = (
  lines: readonly string[],
  start: number,
  end: number,
  parentIndent: number,
  folded: boolean,
): { value: string; next: number } => {
  const collected: string[] = []
  let index = start
  while (index < end) {
    const line = lines[index] ?? ""
    if (line.trim() !== "" && indentOf(line) <= parentIndent) break
    collected.push(line)
    index += 1
  }

  const indents = collected.filter((line) => line.trim() !== "").map(indentOf)
  const base = indents.length === 0 ? 0 : Math.min(...indents)
  const texts = collected.map((line) => line.slice(base))
  while (texts.length > 0 && texts[texts.length - 1] === "") texts.pop()

  return { value: folded ? texts.filter((text) => text !== "").join(" ") : texts.join("\n"), next: index }
}

export function parseSkillFrontmatter(text: string, filePath: string): FrontmatterResult {
  const lines = text.split("\n")
  if ((lines[0] ?? "").trim() !== FENCE) {
    return { ok: true, frontmatter: {}, body: text, diagnostics: [] }
  }

  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === FENCE) {
      close = index
      break
    }
  }
  if (close < 0) return { ok: false, reason: "unterminated fence" }

  const body = lines.slice(close + 1).join("\n")
  const scalars = new Map<string, string>()
  const metadata = new Map<string, string>()
  const diagnostics: string[] = []
  let parent = ""

  for (let index = 1; index < close; index += 1) {
    const line = lines[index] ?? ""
    if (line.trim() === "" || line.trim().startsWith("#")) continue

    const indent = indentOf(line)
    const content = line.trim()
    if (indent > 0 && parent !== "metadata") continue

    const separator = content.indexOf(":")
    if (separator < 0) {
      if (indent > 0) continue
      return { ok: false, reason: `unparsable line ${index + 1}: ${content}` }
    }

    const key = content.slice(0, separator).trim()
    const value = content.slice(separator + 1).trim()

    const target = indent > 0 ? metadata : scalars
    if (indent === 0) parent = ""

    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block = readBlockScalar(lines, index + 1, close, indent, value.startsWith(">"))
      target.set(key, block.value)
      index = block.next - 1
      continue
    }

    if (isUnsupported(value)) {
      diagnostics.push(`unsupported frontmatter: ${filePath}: ${key}`)
      continue
    }

    if (indent === 0) {
      if (key === "metadata") {
        if (value === "") parent = "metadata"
        else diagnostics.push(`unsupported frontmatter: ${filePath}: ${key}`)
        continue
      }
      if (value === "") continue
      if (SCALAR_KEYS.has(key)) scalars.set(key, unquote(value))
      continue
    }

    metadata.set(key, unquote(value))
  }

  const name = scalars.get("name")
  const description = scalars.get("description")
  const autoinvoke = metadata.has("opencode/autoinvoke")
    ? booleanValue(metadata.get("opencode/autoinvoke") ?? "")
    : undefined
  const disableModelInvocation = scalars.has("disable-model-invocation")
    ? booleanValue(scalars.get("disable-model-invocation") ?? "")
    : undefined

  return {
    ok: true,
    frontmatter: {
      ...(name === undefined || name === "" ? {} : { name }),
      ...(description === undefined || description === "" ? {} : { description }),
      ...(autoinvoke === undefined ? {} : { autoinvoke }),
      ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
    },
    body,
    diagnostics,
  }
}
