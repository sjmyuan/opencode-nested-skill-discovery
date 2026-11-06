import { readFile } from "node:fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RegistrySnapshot } from "../src/contracts.ts"
import { applyRegistry } from "../src/replay.ts"
import { fakeContext } from "./support/fake-context.ts"
import { registryEntry } from "./support/registry-fixtures.ts"

const fsCalls = vi.hoisted(() => ({
  readFile: 0,
  realpath: 0,
  readdir: 0,
  stat: 0,
  lstat: 0,
  open: 0,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const stub = (name: keyof typeof fsCalls) => async () => {
    fsCalls[name] += 1
    throw new Error(`${name} must not be called during replay`)
  }

  return {
    ...actual,
    readFile: stub("readFile"),
    realpath: stub("realpath"),
    readdir: stub("readdir"),
    stat: stub("stat"),
    lstat: stub("lstat"),
    open: stub("open"),
  }
})

const snapshot: RegistrySnapshot = {
  location: "/loc/root",
  snapshots: [
    {
      scopeToken: "token-a",
      directory: "/loc/root/A",
      skills: [
        registryEntry({ id: "nested.a.1", canonicalPath: "/loc/root/A/a/SKILL.md" }),
        registryEntry({ id: "nested.a.2", canonicalPath: "/loc/root/A/b/SKILL.md" }),
        registryEntry({ id: "nested.a.3", canonicalPath: "/loc/root/A/c/SKILL.md" }),
      ],
    },
  ],
}

beforeEach(() => {
  for (const name of Object.keys(fsCalls) as (keyof typeof fsCalls)[]) fsCalls[name] = 0
})

describe("replay without I/O", () => {
  it("adds every entry synchronously without touching fs or storage", async () => {
    const fake = fakeContext()
    let storageCalls = 0
    const storage = new Proxy(
      {},
      {
        get: () => {
          storageCalls += 1
          return () => {
            throw new Error("storage must not be read during replay")
          }
        },
      },
    )
    ;(fake.ctx as unknown as { storage: unknown }).storage = storage
    await fake.ctx.skill.transform((editor) => applyRegistry(editor, snapshot))

    const transform = fake.transforms[0]
    expect(transform).toBeDefined()
    expect(() => transform!(fake.editor)).not.toThrow()

    expect(fake.editor.list()).toHaveLength(3)
    expect(storageCalls).toBe(0)
    expect(fsCalls).toEqual({ readFile: 0, realpath: 0, readdir: 0, stat: 0, lstat: 0, open: 0 })
  })

  it("proves the filesystem stubs are live", async () => {
    await expect(readFile("/nope")).rejects.toThrow("readFile must not be called during replay")

    expect(fsCalls.readFile).toBe(1)
  })
})
