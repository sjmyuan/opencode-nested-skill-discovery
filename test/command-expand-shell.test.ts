import { describe, expect, it } from "vitest"
import { expandCommand } from "../src/command-expand.ts"
import {
  cmdTarget,
  failed,
  fakeRunner,
  posixTarget,
  ran,
  scriptedRunner,
  type FakeOutcome,
  type FakeRunner,
} from "./support/command-fixtures.ts"

/**
 * Shell mechanics beyond the golden table (plan step 5): match order, concurrency 2,
 * failure mapping, and the guarantee that a template without `!`cmd`` never reaches
 * the process seam at all.
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const expand = (template: string, runner: FakeRunner, cwd = "/loc/sub") =>
  expandCommand({
    template,
    args: "",
    shell: { target: posixTarget(), cwd, run: runner.run },
  })

const failure = (source: string, message: string): string =>
  `Shell interpolation failed for ${JSON.stringify(source)}: ${message}`

describe("shell interpolation mechanics", () => {
  it("never calls the runner when there is no match", async () => {
    const runner = fakeRunner()
    const result = await expand("run `code` here", runner)

    expect(result.text).toBe("run `code` here")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
    expect(runner.calls).toHaveLength(0)
  })

  it("caps in-flight commands at two across five deferred calls", async () => {
    const runner = fakeRunner()
    const pending = expand("!`a` !`b` !`c` !`d` !`e`", runner)

    expect(runner.calls).toHaveLength(2)
    expect(runner.pending().map((call) => call.index)).toEqual([0, 1])

    const outputs = ["one", "two", "three", "four", "five"]
    while (runner.pending().length > 0) {
      const call = runner.pending().at(-1)
      if (call === undefined) break
      runner.resolve(call.index, ran(outputs[call.index] ?? ""))
      await flush()
    }

    const result = await pending
    expect(result.text).toBe("one two three four five")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
    expect(runner.maxInFlight).toBe(2)
    expect(runner.calls).toHaveLength(5)
  })

  it("substitutes in match order even when settlement order is reversed", async () => {
    const runner = fakeRunner()
    const pending = expand("!`one` !`two` !`three`", runner)

    runner.resolve(1, ran("TWO"))
    await flush()
    runner.resolve(2, ran("THREE"))
    await flush()
    runner.resolve(0, ran("ONE"))

    const result = await pending
    expect(result.text).toBe("ONE TWO THREE")
  })

  it("maps a synchronously throwing runner to the failure outcome", async () => {
    const result = await expandCommand({
      template: "!`boom`",
      args: "",
      shell: {
        target: posixTarget(),
        cwd: "/loc/sub",
        run: () => {
          throw new Error("sync boom")
        },
      },
    })

    expect(result.text).toBe("")
    expect(result.diagnostics).toEqual([failure("boom", "sync boom")])
    expect(result.shellFailed).toBe(true)
  })

  it("maps a rejecting runner to the failure outcome", async () => {
    const result = await expandCommand({
      template: "!`boom`",
      args: "",
      shell: {
        target: posixTarget(),
        cwd: "/loc/sub",
        run: () => Promise.reject(new Error("async boom")),
      },
    })

    expect(result.text).toBe("")
    expect(result.diagnostics).toEqual([failure("boom", "async boom")])
    expect(result.shellFailed).toBe(true)
  })

  it("emits one diagnostic per failed match, in match order", async () => {
    const outcomes: readonly FakeOutcome[] = [failed("first"), ran("ok"), failed("third")]
    const runner = scriptedRunner(outcomes)
    const result = await expand("!`a` !`b` !`c`", runner)

    expect(result.text).toBe(" ok ")
    expect(result.diagnostics).toEqual([failure("a", "first"), failure("c", "third")])
    expect(result.shellFailed).toBe(true)
  })

  it("passes the resolved target and caller cwd to every call", async () => {
    const runner = scriptedRunner([ran("x")])
    await expandCommand({
      template: "!`echo hi`",
      args: "",
      shell: { target: cmdTarget("C:\\Windows\\System32\\cmd.exe"), cwd: "/loc/sub", run: runner.run },
    })

    expect(runner.calls).toEqual([
      { file: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "echo hi"], cwd: "/loc/sub" },
    ])
  })
})
