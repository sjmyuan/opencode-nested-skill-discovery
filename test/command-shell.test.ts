import { describe, expect, it } from "vitest"
import { resolveShell, shellArgs } from "../src/command-shell.ts"
import { cmdTarget, posixTarget, powershellTarget } from "./support/command-fixtures.ts"

/**
 * PD7 shell resolution table, executed purely over injected `{env, platform}` so the
 * win32 rows are covered on this host. Native ranks pwsh/powershell/git-bash above
 * `COMSPEC` by PATH lookup (`packages/core/src/shell/select.ts:100-114`); this cell
 * resolves `SHELL` then `COMSPEC` only (ADR Q1/Q7, delivery decision).
 */

describe("resolveShell", () => {
  it("prefers SHELL over COMSPEC", () => {
    expect(
      resolveShell({
        env: { SHELL: "/usr/bin/bash", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
      }),
    ).toEqual({ file: "/usr/bin/bash", family: "posix" })
  })

  it("win32 without SHELL uses COMSPEC", () => {
    expect(
      resolveShell({ env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, platform: "win32" }),
    ).toEqual({ file: "C:\\Windows\\System32\\cmd.exe", family: "cmd" })
  })

  it("win32 with neither variable yields cmd.exe", () => {
    expect(resolveShell({ env: {}, platform: "win32" })).toEqual({ file: "cmd.exe", family: "cmd" })
  })

  it("classifies a pwsh SHELL as powershell", () => {
    expect(
      resolveShell({ env: { SHELL: "/usr/local/bin/pwsh.exe" }, platform: "linux" }),
    ).toEqual({ file: "/usr/local/bin/pwsh.exe", family: "powershell" })
  })

  it("classifies a PowerShell COMSPEC as powershell", () => {
    expect(
      resolveShell({
        env: { COMSPEC: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
        platform: "win32",
      }),
    ).toEqual({
      file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      family: "powershell",
    })
  })

  it("darwin without SHELL yields /bin/zsh", () => {
    expect(resolveShell({ env: {}, platform: "darwin" })).toEqual({
      file: "/bin/zsh",
      family: "posix",
    })
  })

  it("other POSIX without SHELL yields /bin/sh", () => {
    expect(resolveShell({ env: {}, platform: "linux" })).toEqual({
      file: "/bin/sh",
      family: "posix",
    })
  })

  it("an empty SHELL falls through to COMSPEC on win32", () => {
    expect(
      resolveShell({ env: { SHELL: "", COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, platform: "win32" }),
    ).toEqual({ file: "C:\\Windows\\System32\\cmd.exe", family: "cmd" })
  })

  it("an empty SHELL falls through to the platform default elsewhere", () => {
    expect(resolveShell({ env: { SHELL: "" }, platform: "darwin" })).toEqual({
      file: "/bin/zsh",
      family: "posix",
    })
  })

  it("an unrecognized COMSPEC basename is still the cmd family", () => {
    expect(
      resolveShell({ env: { COMSPEC: "C:\\tools\\interpret.exe" }, platform: "win32" }),
    ).toEqual({ file: "C:\\tools\\interpret.exe", family: "cmd" })
  })

  it("an unrecognized SHELL basename is the posix family", () => {
    expect(resolveShell({ env: { SHELL: "/usr/local/bin/fish" }, platform: "linux" })).toEqual({
      file: "/usr/local/bin/fish",
      family: "posix",
    })
  })
})

describe("shellArgs", () => {
  const command = `echo "a b"`

  it("posix keeps the command as one argument after -c", () => {
    expect(shellArgs(posixTarget(), command)).toEqual(["-c", command])
  })

  it("cmd keeps the command as one argument after /c", () => {
    expect(shellArgs(cmdTarget(), command)).toEqual(["/c", command])
  })

  it("powershell uses the native five-element form", () => {
    expect(shellArgs(powershellTarget(), command)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ])
  })

  it("never splits the command on whitespace", () => {
    for (const target of [posixTarget(), cmdTarget(), powershellTarget()]) {
      expect(shellArgs(target, command).at(-1)).toBe(command)
    }
  })
})
