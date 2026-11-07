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

export interface CommandFrontmatter {
  readonly description?: string
  readonly agent?: string
  readonly model?: string
  readonly subagent?: boolean
}

export type CommandFrontmatterResult =
  | {
      readonly ok: true
      readonly frontmatter: CommandFrontmatter
      readonly template: string
      readonly diagnostics: readonly string[]
    }
  | { readonly ok: false; readonly reason: string }

const FENCE = "---"
const SCALAR_KEYS = new Set(["name", "description", "disable-model-invocation"])
const COMMAND_SCALAR_KEYS = new Set(["description", "agent", "model"])
const COMMAND_BOOLEAN_KEYS = new Set(["subagent", "subtask"])

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

/**
 * A command file's frontmatter plus its verbatim template (ADR command R16; plan PD2).
 *
 * Command documents share the skill fence grammar but accept a different key set, so a
 * syntactic problem drops the whole file instead of a single key: an unparsable line, an
 * unterminated fence, a collection or nested mapping, or a non-boolean flag.
 */
export function parseCommandFrontmatter(text: string, filePath: string): CommandFrontmatterResult {
  const lines = text.split("\n")
  if ((lines[0] ?? "").trim() !== FENCE) {
    return { ok: true, frontmatter: {}, template: text, diagnostics: [] }
  }

  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === FENCE) {
      close = index
      break
    }
  }
  if (close < 0) return { ok: false, reason: "unterminated fence" }

  const template = lines.slice(close + 1).join("\n")
  const scalars = new Map<string, string>()
  const flags = new Map<string, boolean>()
  let parent = ""

  for (let index = 1; index < close; index += 1) {
    const line = lines[index] ?? ""
    if (line.trim() === "" || line.trim().startsWith("#")) continue

    const indent = indentOf(line)
    const content = line.trim()
    if (indent > 0) {
      return {
        ok: false,
        reason: parent === "" ? `unparsable line ${index + 1}: ${content}` : `nested mapping under ${parent}`,
      }
    }

    const separator = content.indexOf(":")
    if (separator < 0) return { ok: false, reason: `unparsable line ${index + 1}: ${content}` }

    const key = content.slice(0, separator).trim()
    const value = content.slice(separator + 1).trim()
    parent = key

    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block = readBlockScalar(lines, index + 1, close, indent, value.startsWith(">"))
      index = block.next - 1
      if (COMMAND_SCALAR_KEYS.has(key)) scalars.set(key, block.value)
      continue
    }

    if (value === "") continue

    if (isUnsupported(value)) {
      if (COMMAND_SCALAR_KEYS.has(key) || COMMAND_BOOLEAN_KEYS.has(key)) {
        return { ok: false, reason: `unsupported frontmatter: ${filePath}: ${key}` }
      }
      continue
    }

    if (COMMAND_SCALAR_KEYS.has(key)) {
      scalars.set(key, unquote(value))
      continue
    }

    if (COMMAND_BOOLEAN_KEYS.has(key)) {
      const flag = booleanValue(value)
      if (flag === undefined) return { ok: false, reason: `unsupported frontmatter: ${filePath}: ${key}` }
      flags.set(key, flag)
    }
  }

  const description = scalars.get("description")
  const agent = scalars.get("agent")
  const model = scalars.get("model")
  const subagent = flags.has("subagent") ? flags.get("subagent") : flags.get("subtask")

  return {
    ok: true,
    frontmatter: {
      ...(description === undefined || description === "" ? {} : { description }),
      ...(agent === undefined || agent === "" ? {} : { agent }),
      ...(model === undefined || model === "" ? {} : { model }),
      ...(subagent === undefined ? {} : { subagent }),
    },
    template,
    diagnostics: [],
  }
}
