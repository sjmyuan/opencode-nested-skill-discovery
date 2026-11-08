import path from "node:path"
import type { StoragePort } from "../../src/manifest.ts"
import { writeCommand } from "./command-family-fixtures.ts"
import type { FakeContext } from "./fake-context.ts"
import { checkoutSkill, createFamilyWorkspace, type FamilyWorkspace } from "./family-fixtures.ts"

export interface PublishWorkspace extends FamilyWorkspace {
  /** The scan location, one level below the root so native command files can sit above it. */
  readonly base: string
  readonly checkout: string
  command(root: "command" | "commands", relName: string): Promise<string>
  commandDoc(root: "command" | "commands", relName: string, content: string): Promise<string>
  skill(relPath: string, slug: string): Promise<string>
}

/** A skill-bearing subproject `A` under a scan location (`A` unless `relative` moves it). */
export async function publishWorkspace(relative = ""): Promise<PublishWorkspace> {
  const ws = await createFamilyWorkspace()
  const prefix = relative.split(path.sep).join("/")
  const base = path.join(ws.root, relative)
  const checkout = path.posix.join(prefix, "A")
  await checkoutSkill(ws, checkout, "checkout")

  return {
    ...ws,
    base,
    checkout: path.join(ws.root, checkout),
    command: (root, relName) => writeCommand(ws, checkout, root, relName),
    commandDoc: (root, relName, content) =>
      ws.write(path.posix.join(checkout, ".opencode", root, relName), content),
    skill: (relPath, slug) => checkoutSkill(ws, path.posix.join(checkout, relPath), slug),
  }
}

/** The skill editor's state as a comparable string: the byte-identical guard of R11. */
export const skillSignature = (fake: FakeContext): string => JSON.stringify(fake.editor.list())

export const isSkillKey = (key: string): boolean =>
  !key.includes("/commands/") && (key.includes("/manifest/") || key.includes("/subproject/"))

export const isCommandKey = (key: string): boolean => key.startsWith("nested/commands/")

/** Records every `storage.set` key in order, leaving the storage behaviour untouched. */
export function recordStorage(fake: FakeContext): readonly string[] {
  const writes: string[] = []
  const target = fake.ctx.storage
  const wrapped: StoragePort = {
    get: (key) => target.get(key),
    set: async (key, value) => {
      writes.push(key)
      await target.set(key, value)
    },
    remove: (key) => target.remove(key),
    scan: (options) => target.scan(options),
  }
  ;(fake.ctx as unknown as { storage: StoragePort }).storage = wrapped
  return writes
}

/** The command storage as a comparable byte map. */
export const commandStorage = (fake: FakeContext): Readonly<Record<string, unknown>> =>
  Object.fromEntries([...fake.storage].filter(([key]) => isCommandKey(key)))
