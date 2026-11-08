import { isAbsolute, relative, sep } from "node:path"

/**
 * Lexical containment: `child` is `parent` itself or below it.
 *
 * Only the `..` segment escapes. A name that merely starts with two dots
 * (`..cache`) is a legal child, so a prefix test would refuse it.
 */
export const isPathInside = (parent: string, child: string): boolean => {
  const relativePath = relative(parent, child)
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}
