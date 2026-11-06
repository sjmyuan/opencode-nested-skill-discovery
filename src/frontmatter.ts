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

export function parseSkillFrontmatter(_text: string, _filePath: string): FrontmatterResult {
  return { ok: true, frontmatter: {}, body: "", diagnostics: [] }
}
