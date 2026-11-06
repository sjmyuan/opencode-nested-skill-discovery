import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildFixture, installPlugin, MATRIX, removeTree } from "./fixture.mjs"
import { listTree } from "./fixture.mjs"
import { api, poll, reload, startServe } from "./lib.mjs"

const WALL_CLOCK_MS = 10 * 60 * 1000

const options = parseArgs(process.argv.slice(2))
const claims = []
const state = { fixture: undefined, servers: [], keep: options.keep, finished: false }

function parseArgs(argv) {
  const parsed = { suite: "all", evidence: join(tmpdir(), "f8-smoke-evidence"), keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--suite") parsed.suite = argv[++index]
    else if (arg === "--evidence") parsed.evidence = resolve(argv[++index])
    else if (arg === "--keep") parsed.keep = true
    else throw new Error(`unknown argument ${arg}`)
  }
  return parsed
}

function record(id, status, detail, evidence) {
  claims.push({ id, status, detail, evidence })
  console.log(`${status.toUpperCase().padEnd(9)} ${id}  ${detail}`)
  return status
}

function worktree() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
  return { root, head, base: execFileSync("git", ["rev-parse", "--short", "HEAD~1"], { encoding: "utf8" }).trim() }
}

async function recordFile(evidence, name, value) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(join(evidence, name), text)
  return name
}

async function cleanup() {
  for (const server of state.servers.splice(0)) {
    try {
      await server.stop()
    } catch (error) {
      console.error(`stop ${server.pid}: ${error.message}`)
    }
  }
  if (state.fixture !== undefined && !state.keep) removeTree(state.fixture.root)
}

async function finish(code) {
  if (state.finished) return
  state.finished = true
  clearTimeout(guard)
  await cleanup()
  writeSummary(code)
  process.exit(code)
}

function writeSummary(code) {
  const meta = {
    suite: options.suite,
    exit: code,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    opencode: versionOf("opencode"),
    worktree: safeWorktree(),
    keep: state.keep,
  }
  writeFileSync(join(options.evidence, "summary.json"), `${JSON.stringify({ meta, claims }, null, 2)}\n`)
  const rows = claims.map((claim) => `| ${claim.id} | ${claim.status} | ${claim.detail} | ${claim.evidence} |`)
  const table = ["| Claim | Status | Detail | Evidence |", "|---|---|---|---|", ...rows].join("\n")
  writeFileSync(join(options.evidence, "summary.md"), `# Smoke summary\n\n${table}\n`)
  console.log(`\n${table}\n\nexit=${code} evidence=${options.evidence}`)
}

function versionOf(command) {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8" }).trim()
  } catch {
    return "unavailable"
  }
}

function safeWorktree() {
  try {
    return worktree()
  } catch {
    return { root: "unknown", head: "unknown", base: "unknown" }
  }
}

const guard = setTimeout(() => {
  record("GUARD", "fail", `wall clock exceeded ${WALL_CLOCK_MS} ms`, "summary.json")
  void finish(1)
}, WALL_CLOCK_MS)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.error(`received ${signal}`)
    void finish(130)
  })
}

async function suiteFixture(evidence, keep) {
  const fixture = buildFixture()
  state.fixture = fixture
  const tree = listTree(fixture.root)
  await recordFile(evidence, "fixture-tree.txt", `${tree.join("\n")}\n`)

  const link = lstatSync(fixture.alias)
  const missing = MATRIX.filter((entry) => !existsSync(join(fixture.real, entry.path)))
  const problems = []
  if (!link.isSymbolicLink()) problems.push("alias is not a symlink")
  if (readlinkSync(fixture.alias) !== fixture.real) problems.push("alias does not point at real")
  if (missing.length > 0) problems.push(`missing ${missing.map((entry) => entry.path).join(", ")}`)
  if (!existsSync(join(fixture.config, "skills/global-demo/SKILL.md"))) problems.push("missing global skill")

  record(
    "FIXTURE",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? `${MATRIX.length} location entries + 1 global + alias symlink`
      : problems.join("; "),
    "fixture-tree.txt",
  )

  if (keep) console.log(`fixture kept at ${fixture.root}`)
  return problems.length === 0
}

async function suiteSmoke(evidence, keep) {
  throw new Error("suite smoke is not implemented yet")
}

async function suiteReal(evidence) {
  throw new Error("suite real is not implemented yet")
}

async function main() {
  mkdirSync(options.evidence, { recursive: true })
  state.startedAt = new Date().toISOString()
  console.log(`suite=${options.suite} evidence=${options.evidence}`)

  if (options.suite === "fixture" || options.suite === "all") await suiteFixture(options.evidence, options.keep)
  if (options.suite === "smoke" || options.suite === "all") await suiteSmoke(options.evidence, options.keep)
  if (options.suite === "real" || options.suite === "all") await suiteReal(options.evidence)

  await finish(claims.some((claim) => claim.status === "fail") ? 2 : 0)
}

main().catch(async (error) => {
  record("HARNESS", "fail", String(error?.stack ?? error).split("\n").slice(0, 6).join(" | "), "harness-error.txt")
  writeFileSync(join(options.evidence, "harness-error.txt"), `${error?.stack ?? error}\n`)
  await finish(1)
})
