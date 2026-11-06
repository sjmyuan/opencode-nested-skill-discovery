# Live conformance smoke

Reproducible, evidence-producing harness for the `nested-skill-discovery` plugin on
`opencode v2.0.26`. It boots private `opencode serve` processes on `127.0.0.1`, so it
never targets the user's background service.

## Usage

```bash
node smoke/run.mjs --suite fixture --keep      # fixture only, no server
npm run smoke:check -- --suite smoke --evidence <dir>
npm run smoke:check -- --suite real --evidence <dir>
npm run smoke:check -- --suite all --evidence <dir>
```

- `--suite fixture|smoke|real|all` (validated; any other value exits `1`).
- `--evidence <dir>` receives every capture (`summary.json`, `summary.md`, logs).
- `--fixture-root <dir>` pins the workspace instead of `mkdtemp`. The path must be a
  `f8-smoke-ws-*` directory under `$TMPDIR`; it is deleted and rebuilt from `MATRIX`
  first, so ids (which hash the fixture's `realpath`) are stable across runs. Any other
  path exits `1` — the flag deletes a directory.
- `--real-root <dir>` moves the real-workspace probe off `/Users/ganggang/work`
  (default); it is the only way to exercise the pre-existing-`.opencode` abort safely.
- `--keep` leaves the fixture tree for inspection.
- `--allow-unproven` turns an `unproven` claim into exit `0`.

Exit codes: `0` complete and green, `1` harness error (bad flag, missing replay input,
mismatched binding), `2` at least one claim failed, `3` at least one claim is
`unproven` and `--allow-unproven` is absent.

## Replaying a captured `opencode run`

`--c5-run <jsonl> --c5-id <id> --c5-base <dir>` scores an existing capture instead of
spending another model call. Both `--c5-id` and `--c5-base` are **mandatory**, and both
must equal the live settled union's id and base directory; a mismatch is a harness
error (exit `1`), never a verdict. A replay is labelled `pass (replayed)` and carries
`replayed: true` plus a `capture` block (`sha256`, `mtime`, `bytes`, `source`,
`fixtureRoot`, `liveId`, `liveBase`) in `summary.json` and `c5-replay.json`, so it can
never be mistaken for a live run. Delete `--c5-run` once a live C5 is green at a fresh
fixture root.

## Isolation

Servers run with `OPENCODE_TEST_HOME=<fixture>/home` and
`OPENCODE_CONFIG_DIR=<fixture>/config`, so the native skill tier is exactly the
fixture: no ambient `~/.claude` or `~/.agents` skills leak in. Data, cache, auth and
the session database stay on the real XDG paths.

`<tmp>/f8-smoke-ws-*/` holds `real/` (the matrix), `alias -> real` (a symlinked
location) and `config/` (`skills/global-demo`). Every fixture API call addresses the
location explicitly with `?location[directory]=<alias>`; nothing needs `cd` into the
alias, so `process.cwd()` cannot canonicalise it away.

## Side effects

- Two private servers per `smoke` run, each on a free port, stopped in a `finally`.
- One transient symlink under `<real-root>/.opencode/` for `--suite real`, removed in
  the same step; the harness aborts without touching an existing `.opencode`.
- One `opencode run` model call (`deepseek/deepseek-flash`) for a live C5, and one
  session row in the shared data database. The CLI prefers `PWD` over its own cwd, so
  the harness pins `PWD` to the canonical fixture to keep the session in the fixture
  location.

## Claims

| Claim | Assertion |
|---|---|
| C1 | the settled union advertises native, global and nested skills; ids are path-hashed; names are `<subproject>/<native>` |
| C2 | native entries are byte-identical with and without the plugin; the plugin is `active` |
| C3 | after a reload, one id per canonical path: 7 fixture entries, native `deploy`/`foo` surviving, `pkg-a` twins suppressed |
| C4 | a `SKILL.md` edit appears in `/api/skill` within 20 s of polling |
| C5 | one `opencode run` loads `pkg-b/deploy` by exact id (live or a bound replay) |

Watcher timing is recorded, never asserted. C1 and C3 are scored on the stable capture
(`skill-settled.json`); `settle.json` records `{ok, attempts, elapsedMs, stableFor}` and
a settle timeout is reported as `unproven`, not as a contract failure.
