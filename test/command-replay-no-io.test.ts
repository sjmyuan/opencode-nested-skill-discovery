import { readFile } from "node:fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { applyCommands } from "../src/command-replay.ts"
import type { CommandEntry, CommandSnapshotSet } from "../src/contracts.ts"
import type { CommandEditor } from "../src/plugin.ts"

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

const entry = (name: string): CommandEntry => ({
  name,
  canonicalPath: `/loc/root/A/.opencode/command/${name}.md`,
  description: `${name} command`,
  template: `# ${name}\n`,
})

const snapshot: CommandSnapshotSet = {
  location: "/loc/root",
  snapshots: [
    {
      scopeToken: "token-a",
      directory: "/loc/root/A",
      commands: [entry("A:deploy"), entry("A:release"), entry("A:review")],
    },
  ],
}

beforeEach(() => {
  for (const name of Object.keys(fsCalls) as (keyof typeof fsCalls)[]) fsCalls[name] = 0
})

describe("command replay without I/O", () => {
  it("N1: the transform adds every entry with no fs and no storage access", () => {
    let storageAccesses = 0
    const storage = new Proxy(
      {},
      {
        get: () => {
          storageAccesses += 1
          return () => {
            throw new Error("storage must not be read during replay")
          }
        },
      },
    )
    const added: string[] = []
    const editor: CommandEditor = {
      add: (definition) => {
        added.push(definition.name)
      },
    }

    const callback = (target: CommandEditor): void => {
      void storage
      applyCommands(target, snapshot, { lookup: () => undefined })
    }

    expect(() => callback(editor)).not.toThrow()
    expect(added).toEqual(["A:deploy", "A:release", "A:review"])
    expect(storageAccesses).toBe(0)
    expect(fsCalls).toEqual({ readFile: 0, realpath: 0, readdir: 0, stat: 0, lstat: 0, open: 0 })
  })

  it("N2: the fs stubs are live", async () => {
    await expect(readFile("/nope")).rejects.toThrow("readFile must not be called during replay")

    expect(fsCalls.readFile).toBe(1)
  })

  it("N3: the callback is synchronous", () => {
    const editor: CommandEditor = { add: () => undefined }
    const callback = (target: CommandEditor): void => {
      applyCommands(target, snapshot, { lookup: () => undefined })
    }

    const result: unknown = callback(editor)

    expect(result).toBeUndefined()
    expect(typeof result).not.toBe("object")
  })
})
