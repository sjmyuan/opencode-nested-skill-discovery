import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { buildFixture, buildIsolation, installPlugin, listTree, MATRIX, removeTree } from "./fixture.mjs"
import { api, poll, pollStable, redact, reload, startServe } from "./lib.mjs"

const WALL_CLOCK_MS = 10 * 60 * 1000
const STABLE_FOR = 3
const SUITES = ["fixture", "smoke", "real", "all"]
const ID_SHAPE = /^nested\.[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\.[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/
const SETTLED_NESTED = ["pkg-b/deploy", "pkg-c/tidy", "pkg-d/deep/nest/lint"]
const SUPPRESSED_NESTED = ["pkg-a/deploy", "pkg-a/foo"]
const FIXTURE_NATIVE_IDS = ["global-demo", "deploy", "foo", "native-root"]
const BUILTIN = (entry) => String(entry.path).startsWith("/builtin/")
const DEFAULT_REAL_ROOT = "/Users/ganggang/work"

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
})()
const claims = []
const state = {
  fixtures: [],
  fixtureRoot: undefined,
  servers: [],
  scratch: mkdtempSync(join(tmpdir(), "f8-smoke-scratch-")),
  logs: [],
  secrets: [],
  keep: options.keep,
  finished: false,
}

function parseArgs(argv) {
  const parsed = {
    suite: "all",
    evidence: join(tmpdir(), "f8-smoke-evidence"),
    keep: false,
    allowUnproven: false,
    c5Run: undefined,
    c5Id: undefined,
    c5Base: undefined,
    fixtureRoot: undefined,
    realRoot: DEFAULT_REAL_ROOT,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--suite") parsed.suite = argv[++index]
    else if (arg === "--evidence") parsed.evidence = resolve(argv[++index])
    else if (arg === "--keep") parsed.keep = true
    else if (arg === "--allow-unproven") parsed.allowUnproven = true
    else if (arg === "--c5-run") parsed.c5Run = resolve(argv[++index])
    else if (arg === "--c5-id") parsed.c5Id = argv[++index]
    else if (arg === "--c5-base") parsed.c5Base = resolve(argv[++index])
    else if (arg === "--fixture-root") parsed.fixtureRoot = argv[++index]
    else if (arg === "--real-root") parsed.realRoot = resolve(argv[++index])
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!SUITES.includes(parsed.suite)) throw new Error(`invalid --suite ${parsed.suite}`)
  if (parsed.c5Run !== undefined && (parsed.c5Id === undefined || parsed.c5Base === undefined)) {
    throw new Error("--c5-id and --c5-base are mandatory with --c5-run")
  }
  if (parsed.fixtureRoot !== undefined) parsed.fixtureRoot = validateFixtureRoot(parsed.fixtureRoot)
  return parsed
}

function validateFixtureRoot(input) {
  const target = resolve(input)
  const parent = existsSync(dirname(target)) ? realpathSync(dirname(target)) : dirname(target)
  const canonical = join(parent, basename(target))
  const tmp = realpathSync(tmpdir())
  if (!canonical.startsWith(`${tmp}${sep}`) || !basename(target).startsWith("f8-smoke-ws-")) {
    throw new Error(`invalid --fixture-root ${input}: must be a f8-smoke-ws-* directory under ${tmp}`)
  }
  return target
}

function buildAt() {
  if (options.fixtureRoot !== undefined && existsSync(options.fixtureRoot)) removeTree(options.fixtureRoot)
  const fixture = options.fixtureRoot === undefined ? buildFixture() : buildFixture({ root: options.fixtureRoot })
  state.fixtures.push(fixture)
  state.fixtureRoot = realpathSync(fixture.root)
  return fixture
}

function record(id, status, detail, evidence, extra = {}) {
  claims.push({ id, status, detail, evidence, ...extra })
  console.log(`${status.toUpperCase().padEnd(9)} ${id}  ${detail}`)
  return status
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

function worktree() {
  return { root: git(["rev-parse", "--show-toplevel"]), head: git(["rev-parse", "--short", "HEAD"]) }
}

function writeEvidence(name, value) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(join(options.evidence, name), text)
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
  for (const fixture of state.fixtures.splice(0)) if (!state.keep) removeTree(fixture.root)
  removeTree(state.scratch)
}

async function finish(code) {
  if (state.finished) return
  state.finished = true
  clearTimeout(guard)
  persistLogs()
  await cleanup()
  writeSummary(code)
  process.exit(code)
}

function persistLogs() {
  for (const log of state.logs) {
    if (!existsSync(log.file)) continue
    const text = readFileSync(log.file, "utf8")
    const redacted = state.secrets.reduce((value, secret) => redact(value, secret), text)
    writeFileSync(join(options.evidence, log.name), redacted)
  }
}

function writeSummary(code) {
  const meta = {
    suite: options.suite,
    exit: code,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    opencode: versionOf("opencode"),
    worktree: safe(worktree),
    keep: state.keep,
    fixtureRoot: state.fixtureRoot,
    c5Source: options.c5Run ?? "live",
    c5Replayed: claims.some((claim) => claim.replayed === true),
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

function safe(run) {
  try {
    return run()
  } catch {
    return { root: "unknown", head: "unknown" }
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

function serveAt(cwd, env, name) {
  return startServe({ cwd, env, logFile: join(state.scratch, `${name}.log`) }).then((server) => {
    state.servers.push(server)
    state.secrets.push(server.password)
    state.logs.push({ name: `${name}.log`, file: server.logFile })
    return server
  })
}

const serve = (fixture, env, name) => serveAt(fixture.real, env, name)

const nestedOf = (capture) => capture.data.filter((entry) => String(entry.id).startsWith("nested."))
const nativeOf = (capture) => capture.data.filter((entry) => !String(entry.id).startsWith("nested."))
const byId = (left, right) => (String(left.id) < String(right.id) ? -1 : 1)
const withoutBuiltin = (capture) => capture.data.filter((entry) => !BUILTIN(entry))
const entryNamed = (capture, name) => capture.data.find((entry) => String(entry.name) === name)

async function suiteFixture(evidence, keep) {
  const fixture = buildAt()
  const tree = listTree(fixture.root)
  writeEvidence("fixture-tree.txt", `${tree.join("\n")}\n`)

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
      ? `${MATRIX.length} location entries + 1 global + alias symlink at ${fixture.root}`
      : problems.join("; "),
    "fixture-tree.txt",
  )

  if (keep) console.log(`fixture kept at ${fixture.root}`)
  return problems.length === 0
}

async function phaseBaseline(fixture, isolation) {
  const server = await serve(fixture, isolation.env, "serve-fixture-a")
  const location = await api(server.base, server.password, "/api/location", { location: fixture.alias })
  const settled = await poll(() => api(server.base, server.password, "/api/skill", { location: fixture.alias }), {
    until: (value) => FIXTURE_NATIVE_IDS.every((id) => value.data.some((entry) => entry.id === id)),
    timeoutMs: 30_000,
    intervalMs: 250,
  })
  const plugins = await api(server.base, server.password, "/api/plugin", { location: fixture.alias })
  writeEvidence("plugin-baseline.json", plugins)
  writeEvidence("skill-baseline.json", settled.value)
  await server.stop()

  return { location, settled, plugins, skills: settled.value }
}

async function phaseUnion(fixture, isolation) {
  const server = await serve(fixture, isolation.env, "serve-fixture-b")
  const location = await api(server.base, server.password, "/api/location", { location: fixture.alias })
  const active = (value) =>
    value.data.some(
      (plugin) =>
        plugin.source.type === "local" &&
        plugin.state.status === "active" &&
        realpathSync(plugin.source.path).includes(realpathSync(worktree().root)),
    )

  await poll(() => api(server.base, server.password, "/api/plugin", { location: fixture.alias }), {
    until: active,
    timeoutMs: 30_000,
    intervalMs: 250,
  })
  await reload(server.base, server.password)
  const settledPlugins = await poll(
    () => api(server.base, server.password, "/api/plugin", { location: fixture.alias }),
    { until: active, timeoutMs: 30_000, intervalMs: 250 },
  )
  const settledSkills = await poll(
    () => api(server.base, server.password, "/api/skill", { location: fixture.alias }),
    {
      until: (value) => SETTLED_NESTED.every((name) => value.data.some((entry) => entry.name === name)),
      timeoutMs: 30_000,
      intervalMs: 250,
    },
  )

  return { server, location, plugins: settledPlugins.value, skills: settledSkills.value }
}

function claimC1(fixture, settled) {
  const problems = []
  const nested = nestedOf(settled)
  const names = nested.map((entry) => String(entry.name))
  const canonicalReal = realpathSync(fixture.real)

  if (!lstatSync(fixture.alias).isSymbolicLink()) problems.push("alias is not a symlink")
  for (const entry of nested) if (!ID_SHAPE.test(String(entry.id))) problems.push(`id shape ${entry.id}`)
  for (const name of SETTLED_NESTED) if (!names.includes(name)) problems.push(`missing ${name}`)
  if (new Set(names).size !== names.length) problems.push("duplicate nested name")
  if (!names.every((name) => name.includes("/"))) problems.push("nested name without separator")
  for (const entry of nested) {
    if (realpathSync(entry.path) !== entry.path) problems.push(`path not canonical ${entry.path}`)
    if (!String(entry.path).startsWith(`${canonicalReal}/`)) problems.push(`path outside location ${entry.path}`)
  }

  return record(
    "C1",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? `${nested.length} nested entries, ids path-hashed, names qualified`
      : problems.slice(0, 4).join("; "),
    "skill-settled.json",
  )
}

function claimC2(baseline, union) {
  const problems = []
  const stable = (capture) => JSON.stringify([...nativeOf(capture)].sort(byId))
  if (stable(baseline.skills) !== stable(union.skills)) problems.push("native entries differ")

  const localBaseline = baseline.plugins.data.filter((plugin) => plugin.source.type === "local")
  const localUnion = union.plugins.data.filter((plugin) => plugin.source.type === "local")
  if (localBaseline.length !== 0) problems.push(`baseline local plugins ${localBaseline.length}`)
  if (localUnion.length !== 1) problems.push(`union local plugins ${localUnion.length}`)
  const plugin = localUnion[0]
  if (plugin !== undefined) {
    if (plugin.state.status !== "active") problems.push(`plugin state ${plugin.state.status}`)
    const repo = realpathSync(worktree().root)
    if (realpathSync(plugin.source.path) !== repo && !realpathSync(plugin.source.path).startsWith(`${repo}/`)) {
      problems.push(`plugin path ${plugin.source.path}`)
    }
  }

  return record(
    "C2",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? `${nativeOf(union.skills).length} native entries identical; plugin active ${plugin.source.type}`
      : problems.slice(0, 4).join("; "),
    "skill-baseline.json, plugin-union.json",
  )
}

function claimC3(fixture, settled) {
  const relevant = withoutBuiltin(settled)
  const canonicalReal = realpathSync(fixture.real)
  const canonicalConfig = realpathSync(fixture.config)
  const groups = new Map()

  for (const entry of relevant) {
    const key = realpathSync(entry.path)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }

  const collisions = [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([canonicalPath, entries]) => ({
      canonicalPath,
      ids: entries.map((entry) => String(entry.id)),
      rawPaths: entries.map((entry) => String(entry.path)),
    }))
  const ids = relevant.map((entry) => String(entry.id))
  const names = relevant.map((entry) => String(entry.name))
  const problems = []

  if (collisions.length > 0) problems.push(`${collisions.length} canonical path(s) with two ids`)
  for (const id of FIXTURE_NATIVE_IDS) if (!ids.includes(id)) problems.push(`native ${id} missing`)
  if (relevant.length !== 7) problems.push(`total ${relevant.length}, expected 7`)
  for (const name of SUPPRESSED_NESTED) if (names.includes(name)) problems.push(`suppressed twin present ${name}`)
  for (const entry of relevant) {
    const path = realpathSync(entry.path)
    if (!path.startsWith(`${canonicalReal}/`) && !path.startsWith(`${canonicalConfig}/`)) {
      problems.push(`unexpected entry ${entry.id}`)
    }
  }

  writeEvidence("collision-groups.json", { collisions, total: relevant.length, ids: [...ids].sort(), names })

  return record(
    "C3",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? `${groups.size} canonical paths, one id each, ${relevant.length} fixture entries`
      : problems.join("; "),
    "skill-settled.json",
    collisions.length === 0 ? {} : { groups: collisions },
  )
}

async function settleAfterReload(fixture, server, name = "settle.json") {
  await reload(server.base, server.password)
  const result = await pollStable(() => api(server.base, server.password, "/api/skill", { location: fixture.alias }), {
    timeoutMs: 30_000,
    intervalMs: 250,
    stableFor: STABLE_FOR,
    ready: (value) => FIXTURE_NATIVE_IDS.every((id) => value.data.some((entry) => entry.id === id)),
    signature: (value) =>
      withoutBuiltin(value)
        .map((entry) => `${entry.id}::${entry.path}`)
        .sort()
        .join("\n"),
  })
  writeEvidence(name, {
    ok: result.ok,
    attempts: result.attempts,
    elapsedMs: result.elapsedMs,
    stableFor: STABLE_FOR,
    at: new Date().toISOString(),
  })
  return result
}

const C4_EDITED = "---\nname: deploy\ndescription: Edited by the F8 smoke\n---\n# Deploy\n\nDeploys pkg-b.\nEdited by the F8 smoke.\n"

async function claimC4(fixture, server, id) {
  const file = join(fixture.real, "pkg-b/.claude/skills/deploy/SKILL.md")
  writeFileSync(file, C4_EDITED)
  const timeline = []
  const edited = (value) =>
    value.data.some(
      (entry) =>
        String(entry.id) === id &&
        entry.description === "Edited by the F8 smoke" &&
        String(entry.content).includes("Edited by the F8 smoke."),
    )
  const found = await poll(() => api(server.base, server.password, "/api/skill", { location: fixture.alias }), {
    until: edited,
    timeoutMs: 20_000,
    intervalMs: 250,
    onAttempt: ({ at, attempts, value, error }) => {
      const entry = value?.data?.find((candidate) => String(candidate.id) === id)
      timeline.push({ at, attempts, description: entry?.description ?? null, observed: entry !== undefined, error: error ?? null })
    },
  })

  writeEvidence("watch-timeline.json", {
    target: id,
    file,
    ok: found.ok,
    attempts: found.attempts,
    elapsedMs: found.elapsedMs,
    timeline,
  })

  const after = await settleAfterReload(fixture, server, "settle-after-edit.json")
  writeEvidence("skill-after-edit.json", after.value ?? { settled: false })
  if (!after.ok) {
    return record(
      "C4",
      "unproven",
      `post-edit settle timeout after ${after.attempts} attempts`,
      "settle-after-edit.json, watch-timeline.json",
    )
  }
  const survives = after.value.data.some(
    (entry) => String(entry.id) === id && entry.description === "Edited by the F8 smoke",
  )

  const problems = []
  if (!found.ok) problems.push(`no edit observed within 20 s (${found.attempts} polls)`)
  if (!survives) problems.push("edit did not survive the settled reload")

  return record(
    "C4",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0 ? `visible after ${found.attempts} polls; settled reload keeps it` : problems.join("; "),
    "watch-timeline.json, skill-after-edit.json, settle-after-edit.json",
  )
}

function runSkillLoad(fixture, server, id) {
  const directory = realpathSync(fixture.real)
  const args = [
    "run",
    "--server",
    server.base,
    "--auto",
    "-m",
    "deepseek/deepseek-flash",
    "--format",
    "json",
    `Call the skill tool with id "${id}". Then output the skill name and the base directory it returned.`,
  ]
  const child = spawn("opencode", args, {
    cwd: fixture.real,
    env: { ...process.env, OPENCODE_PASSWORD: server.password, PWD: directory },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
  return new Promise((resolveRun) => {
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      writeFileSync(join(options.evidence, "run-skill-load.jsonl"), stdout)
      writeFileSync(join(options.evidence, "run-skill-load.err.txt"), stderr)
      resolveRun({ code, signal })
    })
  })
}

function skillUsesOf(capture) {
  return capture
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const event = JSON.parse(line)
        return event.type === "tool_use" && event.part?.tool === "skill" ? [event] : []
      } catch {
        return []
      }
    })
}

function scoreC5(capture, { id, base }, source, extra = {}) {
  const uses = skillUsesOf(capture)
  const matching = uses.filter((event) => {
    const output = String(event.part?.state?.output ?? "")
    return (
      String(event.part?.state?.input?.id) === id &&
      output.includes('<skill_content name="pkg-b/deploy">') &&
      output.includes(`Base directory for this skill: ${base}`)
    )
  })

  if (uses.length === 0) return record("C5", "unproven", "model did not call skill", source, extra)
  if (uses.length > 1) {
    return record("C5", "fail", `${uses.length} skill tool_use events, expected exactly one`, source, extra)
  }
  if (matching.length === 1) {
    return record(
      "C5",
      extra.replayed ? "pass (replayed)" : "pass",
      `one skill tool_use for ${id}; subproject visible in payload`,
      source,
      extra,
    )
  }
  return record("C5", "fail", "skill tool was called without the expected id or payload", source, extra)
}

function captureBinding(source) {
  const bytes = readFileSync(source)
  return {
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mtime: statSync(source).mtime.toISOString(),
    bytes: bytes.length,
  }
}

async function claimC5(fixture, server, settledEntry) {
  const liveId = String(settledEntry?.id ?? "")
  const liveBase = settledEntry === undefined ? "" : dirname(String(settledEntry.path))
  if (liveId === "" || liveBase === "") {
    return record("C5", "unproven", "settled union has no pkg-b/deploy entry", "skill-settled.json")
  }

  if (options.c5Run !== undefined) {
    if (options.c5Id === undefined || options.c5Base === undefined) {
      throw new Error("--c5-id and --c5-base are mandatory with --c5-run")
    }
    if (options.c5Id !== liveId) {
      throw new Error(`--c5-id ${options.c5Id} does not match the live settled id ${liveId}`)
    }
    const boundBase = realpathSync(options.c5Base)
    if (boundBase !== realpathSync(liveBase)) {
      throw new Error(`--c5-base ${options.c5Base} does not match the live settled base ${liveBase}`)
    }

    const capture = readFileSync(options.c5Run, "utf8")
    writeEvidence("run-skill-load.jsonl", capture)
    const binding = captureBinding(options.c5Run)
    const replay = { ...binding, fixtureRoot: state.fixtureRoot, liveId, liveBase }
    writeEvidence("c5-replay.json", replay)
    return scoreC5(
      capture,
      { id: liveId, base: liveBase },
      "run-skill-load.jsonl",
      { replayed: true, capture: replay },
    )
  }

  const real = realpathSync(fixture.real)
  const settled = await poll(() => api(server.base, server.password, "/api/skill", { location: real }), {
    until: (value) => value.data.some((entry) => String(entry.id) === liveId),
    timeoutMs: 30_000,
    intervalMs: 250,
  })
  writeEvidence("skill-real-location.json", settled.value ?? { settled: false })
  if (!settled.ok) {
    return record(
      "C5",
      "unproven",
      "canonical location never advertised the skill id before the run",
      "skill-real-location.json",
    )
  }

  const run = await runSkillLoad(fixture, server, liveId)
  const capture = readFileSync(join(options.evidence, "run-skill-load.jsonl"), "utf8")
  const result = scoreC5(capture, { id: liveId, base: liveBase }, "run-skill-load.jsonl")
  if (result === "unproven") console.error(`run exit ${run.code}; stderr in run-skill-load.err.txt`)
  return result
}

async function suiteSmoke(evidence, keep) {
  const fixture = buildAt()
  const isolation = buildIsolation(fixture)

  const baseline = await phaseBaseline(fixture, isolation)
  installPlugin(fixture, worktree().root)
  const union = await phaseUnion(fixture, isolation)
  try {
    writeEvidence("plugin-union.json", union.plugins)
    writeEvidence("skill-union.json", union.skills)
    const c2 = claimC2(baseline, union)

    const settled = await settleAfterReload(fixture, union.server)
    if (!settled.ok) {
      record("C1", "unproven", `settle timeout after ${settled.attempts} attempts`, "settle.json")
      record("C3", "unproven", `settle timeout after ${settled.attempts} attempts`, "settle.json")
      record("C4", "unproven", "skipped after a failed settle", "settle.json")
      record("C5", "unproven", "skipped after a failed settle", "settle.json")
      return false
    }

    const stable = settled.value
    writeEvidence("skill-settled.json", stable)
    const c1 = claimC1(fixture, stable)
    const c3 = claimC3(fixture, stable)

    const deployB = entryNamed(stable, "pkg-b/deploy")
    const c4 = await claimC4(fixture, union.server, String(deployB?.id ?? ""))
    const c5 = await claimC5(fixture, union.server, deployB)

    return c1 === "pass" && c2 === "pass" && c3 === "pass" && c4 === "pass" && c5 !== "fail"
  } finally {
    await union.server.stop()
  }
}

async function suiteReal(evidence) {
  const realRoot = options.realRoot
  const opencodeDir = join(realRoot, ".opencode")
  const pluginLink = join(opencodeDir, "plugins/nested-skill-discovery")
  const before = existsSync(opencodeDir) ? "present" : "absent"

  if (before === "present") {
    writeEvidence(
      "real-workspace-rollback.txt",
      `transient=${opencodeDir}\nbefore=present\nafter=present\nserver_pid=none\nreason=pre-existing-opencode\n`,
    )
    return record(
      "REAL",
      "unproven",
      `${opencodeDir} already exists; refusing to merge`,
      "real-workspace-rollback.txt",
    )
  }

  const repo = realpathSync(worktree().root)
  let server
  let failure = "rollback-complete"
  try {
    mkdirSync(join(opencodeDir, "plugins"), { recursive: true })
    symlinkSync(repo, pluginLink, "dir")
    server = await serveAt(realRoot, process.env, "serve-real")

    const isActive = (value) =>
      value.data.some(
        (plugin) =>
          plugin.source.type === "local" &&
          plugin.state.status === "active" &&
          realpathSync(plugin.source.path).startsWith(`${repo}/`),
      )
    const plugins = await poll(() => api(server.base, server.password, "/api/plugin"), {
      until: isActive,
      timeoutMs: 60_000,
      intervalMs: 250,
    })
    const skills = await poll(() => api(server.base, server.password, "/api/skill"), {
      until: (value) => value.data.some((entry) => String(entry.id).startsWith("nested.")),
      timeoutMs: 60_000,
      intervalMs: 250,
    })

    writeEvidence("plugin-real-workspace.json", plugins.value ?? { settled: false })
    writeEvidence("skill-real-workspace.json", skills.value ?? { settled: false })
    return claimReal(skills.value)
  } catch (error) {
    failure = `error:${String(error?.message ?? error).slice(0, 120)}`
    throw error
  } finally {
    if (server !== undefined) await server.stop()
    try {
      unlinkSync(pluginLink)
    } catch {
      // already gone
    }
    removeTree(opencodeDir)
    const after = existsSync(opencodeDir) ? "present" : "absent"
    writeEvidence(
      "real-workspace-rollback.txt",
      `transient=${opencodeDir}\nbefore=${before}\nafter=${after}\nserver_pid=${server?.pid ?? "none"}\nreason=${failure}\n`,
    )
    if (after !== "absent") console.error(`${opencodeDir} still present after rollback`)
  }
}

function claimReal(capture) {
  if (capture === undefined || capture.data === undefined) {
    return record("REAL", "unproven", "real workspace did not settle", "skill-real-workspace.json")
  }
  const nested = capture.data.filter((entry) => String(entry.id).startsWith("nested."))
  const groups = new Map()
  for (const entry of capture.data) {
    let path
    try {
      path = realpathSync(String(entry.path))
    } catch {
      continue
    }
    groups.set(path, [...(groups.get(path) ?? []), String(entry.id)])
  }
  const collisions = [...groups].filter(([, ids]) => ids.length > 1)
  const names = nested.map((entry) => String(entry.name))
  const subprojects = [...new Set(names.map((name) => name.split("/").slice(0, -1).join("/")))].sort()
  const problems = []

  if (nested.length < 15) problems.push(`nested count ${nested.length} < 15`)
  for (const entry of nested) {
    if (!ID_SHAPE.test(String(entry.id))) problems.push(`id shape ${entry.id}`)
    if (!String(entry.name).includes("/")) problems.push(`unqualified name ${entry.name}`)
    if (realpathSync(String(entry.path)) !== String(entry.path)) problems.push(`non-canonical ${entry.path}`)
  }
  if (collisions.length > 0) problems.push(`${collisions.length} canonical collisions`)

  writeEvidence("real-workspace-count.json", {
    nested: nested.length,
    total: capture.data.length,
    subprojects,
    collisions,
  })

  return record(
    "REAL",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? `${nested.length} nested across ${subprojects.length} subprojects; names qualified; paths canonical`
      : problems.slice(0, 4).join("; "),
    "skill-real-workspace.json, real-workspace-rollback.txt",
  )
}

async function main() {
  mkdirSync(options.evidence, { recursive: true })
  state.startedAt = new Date().toISOString()
  console.log(`suite=${options.suite} evidence=${options.evidence}`)

  if (options.suite === "fixture" || options.suite === "all") await suiteFixture(options.evidence, options.keep)
  if (options.suite === "smoke" || options.suite === "all") await suiteSmoke(options.evidence, options.keep)
  if (options.suite === "real" || options.suite === "all") await suiteReal(options.evidence)

  const failed = claims.some((claim) => claim.status === "fail")
  const unproven = claims.some((claim) => claim.status === "unproven")
  if (failed) await finish(2)
  else if (unproven && !options.allowUnproven) await finish(3)
  else await finish(0)
}

main().catch(async (error) => {
  record("HARNESS", "fail", String(error?.stack ?? error).split("\n").slice(0, 6).join(" | "), "harness-error.txt")
  writeFileSync(join(options.evidence, "harness-error.txt"), `${error?.stack ?? error}\n`)
  await finish(1)
})
