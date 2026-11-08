import { describe, expect, it } from "vitest"
import { expandCommand, tokenizeArguments } from "../src/command-expand.ts"
import { failed, fakeRunner, posixTarget, ran, scriptedRunner, type FakeOutcome } from "./support/command-fixtures.ts"

/**
 * Golden vectors G1–G21 (plan PD3/PD4): the native five-step text pipeline, transcribed
 * regex for regex and measured by execution against `opencode-v2.0.26`
 * (`packages/core/src/config/plugin/command.ts:199-213`). G19/G20 are our deliberate
 * `$0` divergence (ADR Q6), asserted here so it can never become accidental.
 */

const expandText = async (template: string, args: string) => {
  const runner = fakeRunner()
  const result = await expandCommand({
    template,
    args,
    shell: { target: posixTarget(), cwd: "/loc/sub", run: runner.run },
  })

  // The text pipeline must never reach the process world.
  expect(runner.calls).toHaveLength(0)
  expect(result.diagnostics).toEqual([])
  expect(result.shellFailed).toBe(false)
  return result
}

const expandShell = async (template: string, outcomes: readonly FakeOutcome[], cwd = "/loc/sub") => {
  const runner = scriptedRunner(outcomes)
  const result = await expandCommand({
    template,
    args: "",
    shell: { target: posixTarget(), cwd, run: runner.run },
  })
  return { result, runner }
}

describe("golden: native text pipeline (G1–G21)", () => {
  it("G1 tokenise, quotes unwrapped", async () => {
    const result = await expandText("run $1", `pkg-a "two words" 'single q' bare`)
    expect(result.text).toBe("run pkg-a two words single q bare")
  })

  it("G2 $N tail absorption", async () => {
    const result = await expandText("fix $2", "a b c d")
    expect(result.text).toBe("fix b c d")
  })

  it("G3 $1 absorbs the whole tail", async () => {
    const result = await expandText("fix $1", "a b c d")
    expect(result.text).toBe("fix a b c d")
  })

  it("G4 out-of-range index", async () => {
    const result = await expandText("no $3", "a b")
    expect(result.text).toBe("no")
  })

  it("G5 mixed indexes", async () => {
    const result = await expandText("$2 then $1", "a b c")
    expect(result.text).toBe("b c then a")
  })

  it("G6 multi-digit index", async () => {
    const result = await expandText("n $10", "a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12")
    expect(result.text).toBe("n a10 a11 a12")
  })

  it("G7 $ARGUMENTS is raw", async () => {
    const result = await expandText("raw is $ARGUMENTS<end>", `  one "two three"  `)
    expect(result.text).toBe(`raw is   one "two three"  <end>`)
  })

  it("G8 $ARGUMENTS after $N", async () => {
    const result = await expandText("$ARGUMENTS / $1", "a b")
    expect(result.text).toBe("a b / a b")
  })

  it("G9 append after a blank line", async () => {
    const result = await expandText("Do the thing.", "my file.md")
    expect(result.text).toBe("Do the thing.\n\nmy file.md")
  })

  it("G10 append trims a trailing template newline", async () => {
    const result = await expandText("Do the thing.\n", "arg")
    expect(result.text).toBe("Do the thing.\n\narg")
  })

  it("G29 append trims every trailing whitespace run", async () => {
    const result = await expandText("Do the thing.\n\n\t  ", "arg")
    expect(result.text).toBe("Do the thing.\n\narg")
  })

  it("G30 append trims trailing spaces with no newline", async () => {
    const result = await expandText("Do the thing.  ", "arg")
    expect(result.text).toBe("Do the thing.\n\narg")
  })

  it("G11 no append on blank input", async () => {
    const result = await expandText("Do the thing.", "   ")
    expect(result.text).toBe("Do the thing.")
  })

  it("G12 trim", async () => {
    const result = await expandText("  padded  ", "")
    expect(result.text).toBe("padded")
  })

  it("G13 no placeholders, no input", async () => {
    const result = await expandText("hi", "")
    expect(result.text).toBe("hi")
  })

  it("G14 [Image N] is one token", async () => {
    const result = await expandText("see $1", "[Image 1] what")
    expect(result.text).toBe("see [Image 1] what")
  })

  it("G15 an apostrophe splits a word", async () => {
    const result = await expandText("x $1", "don't stop")
    expect(result.text).toBe("x don t stop")
  })

  it("G16 unterminated quote", async () => {
    const result = await expandText("x $1", `a "b`)
    expect(result.text).toBe("x a b")
  })

  it("G17 $& in an argument is literal", async () => {
    const result = await expandText("keep $1", "$& literal")
    expect(result.text).toBe("keep $& literal")
  })

  it("G18 @file never expanded", async () => {
    const result = await expandText("read @notes.md then $1", "x")
    expect(result.text).toBe("read @notes.md then x")
  })

  it("G19 ours (Q6): $0 is empty", async () => {
    const result = await expandText("$0", "a b")
    // Native yields "b" here; the ADR rejects that quirk.
    expect(result.text).toBe("")
  })

  it("G20 ours (Q6): $0 never absorbs the tail", async () => {
    const result = await expandText("$0 $1", "a b")
    // Native yields "undefined a b" here; the ADR rejects that quirk.
    expect(result.text).toBe("a b")
  })

  it("G21 a placeholder suppresses the append", async () => {
    const result = await expandText("x $1", "")
    expect(result.text).toBe("x")
  })
})

describe("golden: shell pass (G22–G28)", () => {
  it("G22 shell success", async () => {
    const { result, runner } = await expandShell("run !`echo hi`", [ran("hi\n")])
    expect(result.text).toBe("run hi\n")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
    expect(runner.calls).toHaveLength(1)
  })

  it("G23 shell match order", async () => {
    const { result, runner } = await expandShell("a !`one` b !`two`", [ran("1"), ran("2")])
    expect(result.text).toBe("a 1 b 2")
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-c", "one"],
      ["-c", "two"],
    ])
  })

  it("G24 output $& and $$ stay literal", async () => {
    const { result } = await expandShell("!`emit`", [ran("A$&B$$C")])
    expect(result.text).toBe("A$&B$$C")
  })

  it("G25 non-zero exit is not a failure", async () => {
    const { result } = await expandShell("!`false`", [ran("", 1)])
    expect(result.text).toBe("")
    expect(result.diagnostics).toEqual([])
    expect(result.shellFailed).toBe(false)
  })

  it("G26 spawn failure is diagnosed and flags the result", async () => {
    const { result } = await expandShell("!`nope`", [failed("ENOENT")])
    expect(result.text).toBe("")
    expect(result.diagnostics).toEqual([`Shell interpolation failed for "nope": ENOENT`])
    expect(result.shellFailed).toBe(true)
  })

  it("G27 trim happens before the shell, with no final trim", async () => {
    const { result, runner } = await expandShell("  !`echo`  ", [ran("hi\n")])
    expect(result.text).toBe("hi\n")
    expect(runner.calls[0]?.args).toEqual(["-c", "echo"])
  })

  it("G28 run shape carries the resolved shell, argv and caller cwd", async () => {
    const { runner } = await expandShell("!`echo hi`", [ran("hi\n")])
    expect(runner.calls).toEqual([{ file: "/bin/zsh", args: ["-c", "echo hi"], cwd: "/loc/sub" }])
  })
})

describe("tokenizeArguments", () => {
  it("keeps quoted runs as one token and unwraps the quotes", () => {
    expect(tokenizeArguments(`one "two words" 'three four' five`)).toEqual([
      "one",
      "two words",
      "three four",
      "five",
    ])
  })

  it("keeps [Image N] together and splits on an apostrophe", () => {
    expect(tokenizeArguments(`[Image 12] don't stop`)).toEqual(["[Image 12]", "don", "t", "stop"])
  })
})
