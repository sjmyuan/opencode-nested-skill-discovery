import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { spawnSync } from "node:child_process"

const EXPECT = "/usr/bin/expect"

const ANSI = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join("|"),
  "g",
)

export const stripAnsi = (text) => text.replace(ANSI, "")

export const hasGlyphs = (text) => /[A-Za-z0-9]/.test(text)

/** Tcl literals for ESC and backslash, so no pattern text needs shell-level escaping. */
const TCL_HEAD = [
  'set esc "\\u001b"',
  'set bs "\\u005c"',
  'set cpr "${esc}${bs}\\u005b6n"',
  'set da1 "${esc}${bs}\\u005bc"',
  'set da2 "${esc}${bs}\\u005b>c"',
  'set cprReply "${esc}\\u005b1;1R"',
  'set da1Reply "${esc}\\u005b?1;2c"',
  'set da2Reply "${esc}\\u005b>0;1;0c"',
]

export function expectScript({ configDir, home, directory, transcript, server }) {
  const target =
    server === undefined ? `--standalone {${directory}}` : `--server {${server}} {${directory}}`
  return [
    "set timeout 30",
    "log_user 0",
    `log_file -a {${transcript}}`,
    ...TCL_HEAD,
    `spawn -noecho env OPENCODE_CONFIG_DIR={${configDir}} OPENCODE_TEST_HOME={${home}} TERM=xterm-256color PWD={${directory}} opencode ${target}`,
    "set sent 0",
    "expect {",
    '  -re "$cpr" { send -- $cprReply; exp_continue }',
    '  -re "$da1" { send -- $da1Reply; exp_continue }',
    '  -re "$da2" { send -- $da2Reply; exp_continue }',
    '  "pkg-b:deploy" { send -- ":deploy"; after 800; send -- "\\r"; after 3000; exit 0 }',
    '  "Ask anything" { if {$sent == 0} { after 2500; send -- "/pkg-b"; set sent 1 }; exp_continue }',
    '  timeout { exit [expr {$sent ? 2 : 3}] }',
    '  eof { exit [expr {$sent ? 2 : 3}] }',
    "}",
    "",
  ].join("\n")
}

/**
 * Drive the real TUI in an `expect` PTY with a terminal-capability responder.
 *
 * `readable` means the screen produced printable glyphs; `sawCommand` means the
 * `:`-qualified name appeared after typing `/pkg-b`. A blank screen is unreadable,
 * never a pass.
 */
export function runTui({ directory, env, evidence, attempt, server }) {
  if (!existsSync(EXPECT)) {
    return {
      attempt,
      readable: false,
      sawCommand: false,
      reason: "expect-absent",
      transcript: null,
      screen: null,
      exit: null,
    }
  }

  const transcriptPath = join(evidence, "tui-transcript.txt")
  const screenPath = join(evidence, "tui-screen.txt")
  const scriptPath = join(tmpdir(), `nested-tui-attempt-${attempt}.exp`)

  // `log_file -a` appends, so a frame from an earlier attempt would otherwise pass this one.
  writeFileSync(transcriptPath, "")
  writeFileSync(screenPath, "")
  writeFileSync(
    scriptPath,
    expectScript({
      configDir: env.OPENCODE_CONFIG_DIR,
      home: env.OPENCODE_TEST_HOME,
      directory,
      transcript: transcriptPath,
      server,
    }),
  )

  const result = spawnSync(EXPECT, ["-f", scriptPath], {
    env: { ...process.env, ...env },
    timeout: 90_000,
    encoding: "utf8",
  })
  if (result.error !== undefined) rmSync(transcriptPath, { force: true })
  const raw = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : ""
  const screen = stripAnsi(raw)
  writeFileSync(screenPath, screen)

  return {
    attempt,
    readable: hasGlyphs(screen),
    sawCommand: screen.includes("pkg-b:deploy"),
    transcript: basename(transcriptPath),
    screen: basename(screenPath),
    exit: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    stderr: `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.slice(0, 400),
  }
}
