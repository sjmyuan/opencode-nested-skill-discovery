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

- `--suite fixture` builds the fixture tree and asserts it; no server.
- `--suite smoke` runs phases A/B on two private servers and evaluates C1–C5.
- `--suite real` checks the real workspace union, then removes its temporary symlink.
- `--suite all` runs every suite.
- `--evidence <dir>` receives every capture (`summary.json`, `summary.md`, logs).
- `--keep` leaves the fixture tree for inspection.

Exit codes: `0` complete and green, `1` harness error, `2` at least one claim failed.
While the F5 dedupe defect is open, `C3` is expected to fail and the run exits `2`.

Recovery flags (`--c5-run <jsonl> --c5-id <id> --c5-base <dir>`) score an already
captured `opencode run` stream instead of spending another model call. The summary
records `meta.c5Source` so a replayed verdict is never mistaken for a live one.

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
- One transient symlink under `/Users/ganggang/work/.opencode/` for `--suite real`,
  removed in the same step; the harness aborts if that directory already exists.
- One `opencode run` model call (`deepseek/deepseek-flash`) for C5, and one session row
  in the shared data database. The CLI prefers `PWD` over its own cwd, so the harness
  pins `PWD` to the canonical fixture to keep the session in the fixture location.

## Claims

| Claim | Assertion |
|---|---|
| C1 | union advertises native, global and nested skills; ids are path-hashed; names are `<subproject>/<native>` |
| C2 | native entries are byte-identical with and without the plugin; the plugin is `active` |
| C3 | after a reload, one id per canonical path (7 entries, not 9) |
| C4 | a `SKILL.md` edit appears in `/api/skill` within 20 s of polling |
| C5 | one `opencode run` loads `pkg-b/deploy` by exact id |

Watcher timing is recorded, never asserted. `skill-settled.json` is captured after an
explicit reload once the union is stable across three polls.
