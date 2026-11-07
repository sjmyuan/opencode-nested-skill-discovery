import { describe, expect, it } from "vitest"
import { expandCommand } from "../src/command-expand.ts"
import { nodeProcessRunner, resolveShell } from "../src/command-shell.ts"

/**
 * The only cases that open a real process (PD9). The target is resolved on the host
 * rather than hardcoded, so the suite behaves like `test/watch-node.test.ts`: one
 * host-conditional file, everything else virtual.
 */

const target = resolveShell({ env: process.env, platform: process.platform })
const shell = { target, cwd: process.cwd(), run: nodeProcessRunner }
const posix = process.platform !== "win32"

describe("real process", () => {
  it.skipIf(!posix)("POSIX: expands printf output with no diagnostic", async () => {
    const result = await expandCommand({ template: "!`printf hi`", args: "", shell })

    expect(result.text).toBe("hi")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
  })

  it.skipIf(!posix)("POSIX: combines stdout and stderr", async () => {
    const result = await expandCommand({
      template: "!`printf out; printf err 1>&2`",
      args: "",
      shell,
    })

    expect(result.text).toContain("out")
    expect(result.text).toContain("err")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
  })

  it.skipIf(posix)("win32: expands echo output after trim", async () => {
    const result = await expandCommand({ template: "!`echo hi`", args: "", shell })

    expect(result.text.trim()).toBe("hi")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
  })

  it.skipIf(!posix)("POSIX: an impossible shell is a spawn failure, not a throw", async () => {
    const result = await expandCommand({
      template: "!`echo hi`",
      args: "",
      shell: {
        target: { file: "/definitely/not/a/shell-binary", family: "posix" },
        cwd: process.cwd(),
        run: nodeProcessRunner,
      },
    })

    expect(result.text).toBe("")
    expect(result.shellFailed).toBe(true)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain('Shell interpolation failed for "echo hi":')
    expect(result.diagnostics[0]).toContain("ENOENT")
  })
})
