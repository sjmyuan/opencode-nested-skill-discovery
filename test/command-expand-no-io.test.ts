import { beforeEach, describe, expect, it, vi } from "vitest"
import { expandCommand } from "../src/command-expand.ts"
import { fakeRunner, posixTarget, ran, scriptedRunner } from "./support/command-fixtures.ts"

/**
 * Guard (plan step 6, precedent `test/replay-no-io.test.ts`): the expander reaches the
 * process world only through the injected runner. Every `node:child_process` and
 * `node:fs/promises` entry point throws, so any accidental direct use fails loudly.
 */

const procCalls = vi.hoisted(() => ({
  spawn: 0,
  exec: 0,
  execFile: 0,
  execSync: 0,
  spawnSync: 0,
}))

const fsCalls = vi.hoisted(() => ({
  readFile: 0,
  writeFile: 0,
  readdir: 0,
  stat: 0,
  lstat: 0,
  open: 0,
  realpath: 0,
  access: 0,
  mkdir: 0,
  rm: 0,
}))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const stub = (name: keyof typeof procCalls) => () => {
    procCalls[name] += 1
    throw new Error(`${name} must not be called during expansion`)
  }

  return {
    ...actual,
    spawn: stub("spawn"),
    exec: stub("exec"),
    execFile: stub("execFile"),
    execSync: stub("execSync"),
    spawnSync: stub("spawnSync"),
  }
})

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const stub = (name: keyof typeof fsCalls) => async () => {
    fsCalls[name] += 1
    throw new Error(`${name} must not be called during expansion`)
  }

  return {
    ...actual,
    readFile: stub("readFile"),
    writeFile: stub("writeFile"),
    readdir: stub("readdir"),
    stat: stub("stat"),
    lstat: stub("lstat"),
    open: stub("open"),
    realpath: stub("realpath"),
    access: stub("access"),
    mkdir: stub("mkdir"),
    rm: stub("rm"),
  }
})

const total = (counters: Record<string, number>): number =>
  Object.values(counters).reduce((sum, value) => sum + value, 0)

const expectNoIo = (): void => {
  expect(total(procCalls)).toBe(0)
  expect(total(fsCalls)).toBe(0)
}

beforeEach(() => {
  for (const name of Object.keys(procCalls) as (keyof typeof procCalls)[]) procCalls[name] = 0
  for (const name of Object.keys(fsCalls) as (keyof typeof fsCalls)[]) fsCalls[name] = 0
})

describe("expandCommand without I/O", () => {
  it("expands a text-only template with zero runner calls and no I/O", async () => {
    const runner = fakeRunner()
    const result = await expandCommand({
      template: "fix $1",
      args: "a b",
      shell: { target: posixTarget(), cwd: "/loc/sub", run: runner.run },
    })

    expect(result.text).toBe("fix a b")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
    expect(runner.calls).toHaveLength(0)
    expectNoIo()
  })

  it("expands a shell template only through the injected runner", async () => {
    const runner = scriptedRunner([ran("hi\n")])
    const result = await expandCommand({
      template: "run !`echo hi`",
      args: "",
      shell: { target: posixTarget(), cwd: "/loc/sub", run: runner.run },
    })

    expect(result.text).toBe("run hi\n")
    expect(runner.calls).toEqual([{ file: "/bin/zsh", args: ["-c", "echo hi"], cwd: "/loc/sub" }])
    expectNoIo()
  })

  it("resolves, never rejects, when the injected runner throws", async () => {
    const result = await expandCommand({
      template: "!`boom`",
      args: "",
      shell: {
        target: posixTarget(),
        cwd: "/loc/sub",
        run: () => {
          throw new Error("runner exploded")
        },
      },
    })

    expect(result.text).toBe("")
    expect(result.diagnostics).toEqual([`Shell interpolation failed for "boom": runner exploded`])
    expect(result.shellFailed).toBe(true)
    expectNoIo()
  })
})
