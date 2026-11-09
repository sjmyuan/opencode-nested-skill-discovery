# Limits

Every bound the plugin accepts, what triggers it, and what you see when it bites. The five
scan budgets are **defaults** declared in `src/contracts.ts:142-148` and each one is
overridable from the plugin entry's `options` object: the registry resolves them once at
construction (`src/options.ts:34-52`, `src/registry.ts:319`) and hands the same object to the
skill scan (`src/registry.ts:546`) and to the native command-name walk
(`src/registry.ts:605`). An auto-discovered directory plugin receives `{}`, so zero-config
behaviour is the defaults — apart from the raised directory budget below.

## Summary

| Limit | Value | Consequence |
|---|---|---|
| Subproject depth | 5 directories below the location | a depth-6 subproject is invisible |
| Directories scanned | 100,000 (default) | scan stops, partial index advertised |
| Skill and command files | 5,000 | scan stops, partial index advertised |
| One skill or command file | 128 KiB | that file is skipped, scan continues |
| Total skill and command bytes | 16 MiB | scan stops, partial index advertised |
| Diagnostics | 200 in the scan, 200 in the refresh outcome | truncated with a summary line, scan continues |
| Native command-name walk | shares the directory and file budgets above; reads no content | a truncated walk stops early and reports `budget-*`; its `complete` flag is computed and never surfaced (`src/command-native.ts:129-133`) |
| Display name | 80 code points | leading path segments dropped behind `…/` |
| Command name | 160 code points (`MAX_COMMAND_NAME_LENGTH`, `src/command-names.ts`) | never truncated: a longer name is kept whole and logged as `name-too-long:`, while skill display names still cut at 80 |
| Skill description | 500 code points | truncated; a command description is stored verbatim and never capped (native parity) |
| Scope slug / skill slug | 24 / 40 characters | slug truncated, hash keeps the ID unique |
| Entry ID | 96 characters declared | structural maximum is 90, so no ID is ever cut |
| Command template | the file body, so the same 128 KiB per-file limit | the whole command file is skipped with `command-oversize:`; the command snapshot adds no new budget |

The command template is the file body after the closing fence, so it is bounded by the shared
128 KiB per-file limit (`src/contracts.ts:142-148`) rather than by a budget of its own. The
snapshot reader re-checks the limit on the bytes it read, because a file can grow between the
scan and the read (`src/command-snapshot.ts:88-91`), and the template is then stored in
`nested/<locationToken>/commands/<scopeToken>` with `description`, `agent`, `model` and `subagent`.
That ceiling is independent of the `maxFileBytes` option: raising the option scans a larger
command file and then drops it at this stage with `command-oversize:`, while lowering it drops
the file before the snapshot stage.

A `model:` selection is canonicalised before storage: both frontmatter forms —
`providerID/model#variant?` and the `{providerID, model, variant?}` mapping — become the one
short string (`src/command-model.ts:58-64`), so the cache, the listing, and the routing
reference can never disagree about which model a command selects.

The template is stored verbatim, but the append step trims the template's trailing whitespace
before inserting the blank line, so a body ending in a newline plus trailing arguments expands
with the same one blank line native produces by trimming at decode
(`packages/core/src/config/plugin/command.ts:177`, `src/command-expand.ts:71-77`).

## Configuring the limits

The five scan budgets are optional plugin options (ADR R8). Only the `opencode.json` object
form carries them — a bare string names the source but passes no options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    {
      "package": "./.opencode/plugins/nested-skill-discovery",
      "options": { "maxDirectories": 100000 }
    }
  ]
}
```

| Option | Default | Bounds |
|---|---|---|
| `maxDepth` | 5 | subproject directories below the location |
| `maxDirectories` | 100,000 | directories visited by the scan, and by the native command walk |
| `maxFiles` | 5,000 | admitted skill and command files, both walks |
| `maxFileBytes` | 131,072 (128 KiB) | one skill or command file |
| `maxTotalBytes` | 16,777,216 (16 MiB) | all admitted bytes together |

Resolution is fail-safe per key (`src/options.ts:34-52`): a value that is not a finite number
`>= 0` — a string such as `"100000"`, `null`, `true`, `NaN`, `Infinity`, a negative — falls
back to that key's default, activation still succeeds, and the refresh outcome carries one
location-independent line:

```
option-invalid: maxDirectories="100000"
```

Each rejected key gets its own line, in the order above, inside the existing 200-line
diagnostic cap. Everything else is quiet, and the sharp edges are these:

- **A typo is invisible.** An unknown key (`maxDirectorie`) is ignored silently, so the
  default applies with no diagnostic.
- **`0` is a value, not an error.** `maxDepth: 0` keeps only the location's own roots;
  `maxDirectories: 0` or `maxFiles: 0` admits nothing, advertises an empty index, and reports
  `truncated`.
- **No ceiling.** Any large finite value is honoured, so `maxTotalBytes: 1e15` disables that
  budget in practice.
- **Non-integers are thresholds.** `maxFiles: 2.5` admits two files and stops on the third.
- **A raised budget costs time.** The cold walk is linear in the directories visited; the
  prompt-triggered refresh is throttled, not bounded, by the directory budget.
- **The command template keeps its own ceiling.** `buildCommandSnapshot` re-checks
  `maxFileBytes` at its default 128 KiB regardless of the option
  (`src/command-snapshot.ts:88-91`): raise the option and a >128 KiB command file is scanned
  and then dropped with `command-oversize:`; lower it and the scan drops the file first.
- **A directory plugin gets no options.** Discovery by folder passes `{}`, so an installed
  checkout behaves exactly as before, at the raised 100,000 directory budget.

## Depth

Depth counts directories between the location and the **subproject** — a directory that
carries a marker — not directories between the location and the skill file
(`src/scan.ts:147`, `163-166`; `src/contracts.ts:110-116`).

- a subproject at depth 5 is discovered, and its `SKILL.md` may sit many levels deeper
  (`test/scan.test.ts:213-224`)
- a subproject at depth 6 is invisible, silently and without a diagnostic
  (`test/scan.test.ts:226-236`)
- inside an opened skill root the walk is unbounded, so
  `A/.opencode/skills/a/b/c/d/e/f/SKILL.md` is still found (`test/scan.test.ts:248-260`)

The location itself is a depth-0 subproject: skills directly under
`<location>/.opencode/skills` are discovered with an empty subproject path
(`test/scan.test.ts:285-295`).

## Pruned directories

The walk skips these names at every level, before classifying the entry, so a pruned symlink
is skipped as silently as a pruned directory (`src/scan.ts:153-158`,
`src/contracts.ts:150-164`):

`node_modules`, `.git`, `.hg`, `.svn`, `.venv`, `venv`, `__pycache__`, `target`, `dist`,
`build`, `.next`, `.cache`, `vendor`

A skill root inside a pruned directory is therefore unreachable — for example
`node_modules/pkg/.opencode/skills/x/SKILL.md` is never discovered, which is what keeps a
copied plugin checkout or an installed dependency from flooding the registry.

## Markers

A marker makes a directory a subproject and gives it a scope token and a name prefix. The
marker kinds are `src/contracts.ts:182-189`:

| Kind | Detected as |
|---|---|
| `opencode-skills` | `.opencode/skills` directory |
| `opencode-skill` | `.opencode/skill` directory |
| `claude-skills` | `.claude/skills` directory |
| `agents-skills` | `.agents/skills` directory |
| `opencode-command` | `.opencode/command` directory |
| `opencode-commands` | `.opencode/commands` directory |
| `agents-md` | `AGENTS.md` file |
| `claude-md` | `CLAUDE.md` file |
| `git` | any `.git` entry (a worktree file counts) |
| `hg` | a real `.hg` directory |

Markers nest and never stop the walk: the deepest marker owner wins, and its relative path
becomes the entry's name prefix (`src/scan.ts:147`, `src/registry.ts:123`). A symlinked
skill-root directory is not a marker and is not followed.

## Worktree families

A linked worktree and its main checkout are one repository. From an ancestor location only
the main working tree's skills are advertised, at the checkout root and in every nested
subproject beneath it; every skill in the linked worktree is hidden, including a skill that
exists only there (`src/family.ts:240-284`, `test/conformance-family.test.ts`,
`test/indexer-family-nested.test.ts`). The main working tree is the checkout whose `.git` is a
directory, not the one whose `.git` is a `gitdir:` file.

- A nested subproject with no `.git` of its own resolves to the nearest ancestor `.git` inside
  the location, so `vscode/extensions/copilot` is compared as part of the `vscode` checkout
  (`src/family.ts:189-231`).
- Derivation is filesystem-only: one memoised `lstat` per ancestor up to the location, one
  `lstat` of `<checkout>/.git` per checkout, and at most one ≤ 4 KB read of a `.git` file,
  never a `git` subprocess (`src/family.ts:58-131`, `155-231`).
- The rule applies only when both checkouts are strict descendants of the location; a
  worktree of a repository outside the workspace, or a session located inside the worktree,
  sees both checkouts unchanged (`test/indexer-family.test.ts` B7–B8,
  `test/conformance-family.test.ts` C7).
- A nested subproject with no `.git` ancestor inside the location is a foreign checkout: it is
  kept and reports no diagnostic (`test/indexer-family-nested.test.ts` B18–B20).
- A `.git` that cannot be read, carries no `gitdir:` line in its first 4 KB, points at a
  missing target, or names a common dir that is not its parent's own `.git` disables the rule
  for that checkout: the entries are advertised as before and one `family:` diagnostic is
  recorded (`test/family.test.ts` A6–A7, A9–A12; `test/family-checkout.test.ts` A22).
- Identical `family:` diagnostics are emitted once per pass: the ancestor walk memoises each
  checkout, so a nested subproject and its enclosing checkout share one line rather than
  repeating it (`test/family-checkout.test.ts` A22).
- Creating a `.git` on an ancestor is outside the watch set, so a nested subproject starts
  deduping at the next prompt or the next file move, not immediately (Q10).
- A command root created inside an already-existing `.opencode` is outside the watch set, and
  so is a command file added back into a root whose last file was deleted: both wait for the
  next prompt. The same shape as a nested `.git` (Q10), accepted rather than pending
  (`src/watch.ts:256-309`, `test/registry-command-refresh.test.ts`).
- Residual: a worktree of a **submodule** (`.git/modules/<n>/worktrees/<wt>`) cannot name a
  survivor, so that pair still double-registers (Q8).
- Residual: deleting the main checkout's `.git` republishes the hidden worktree at the next
  rescan (Q9).

## Candidate files

- directly under a skill root, any `*.md` file
- below that, only `SKILL.md` (`src/scan.ts:248-251`)

A nested `README.md` inside an open skill root is therefore not a skill.

## Refusals

Symlinks are inspected, never followed blindly (`src/scan.ts:196-214`, `269-300`):

| Diagnostic | Meaning |
|---|---|
| `directory-symlink: <rel>` | a symlinked directory (including a symlinked skill root) is not entered |
| `root-refused: <rel>` | a skill root resolves outside the location |
| `file-symlink-outside: <rel>` | a skill file links to a target outside the location |
| `file-symlink-broken: <rel>` | a skill file link whose target does not resolve |
| `unreadable-directory` / `unreadable-file` / `location-unreadable` | the path could not be read; the walk continues |

## Placement

`subagent({..., directory})` moves the child session to the destination before this call's
task is admitted (`src/placement.ts`). The destination is absolute, relative to the location
serving the call, or a `~/` path; the resolved value is `realpath`-normalised and must be a directory.

- the boundary is the caller's location, the project directory (never `/` itself), or one of
  the project's worktrees — the same internal set `FileAccess.resolve` uses
- a placed child **narrows**: it sees the destination's instructions, skills, same-id agents,
  config and permissions, and loses sibling subprojects; a destination's own skills appear as
  native entries, not as `nested.…` unions
- re-placement with `sessionID` keeps the conversation history, but relative paths in that
  history are not rewritten
- a refused destination — missing, a file, or outside the boundary — fails **before** the native
  tool runs: no child is created and the error names only the requested directory
  (`src/placement.ts`)
- a failure after the child exists — move rejected, move unconfirmed, aborted, already started,
  or an unreadable pre-state — leaves the child created and unprompted; nothing is rolled back,
  and the error names the child session, the requested directory and the observed location
  (`src/placement.ts`)
- one 120 s budget covers the `session.move` call **and** its confirmation, because the host
  probes and boots the destination graph inside the call
- this is a context boundary, not a security boundary: the model can still read outside it,
  and the native `opencode_session_move` tool is unchanged

The gate a `directory` call runs is policy on that argument, not a boundary. A deny rule that
targets a nested ID (`nested.*`, `nested.<scope>.*`, or an exact ID) is enforced at placement
only over the entries the parent's registry had indexed at the time of the call. It does not
cover: skills under the destination that the parent never indexed (created after the last
refresh, beyond the depth cap, under a pruned directory, or in a directory without a subproject
marker); the destination's native IDs, which are the IDs those same skills carry after the move;
any later change to the destination's own permission configuration; and any other path into the
destination — including the native `opencode_session_move` tool, which moves a session with no
skill-permission check at all. The `nested.` prefix is a naming convention, not a policy
boundary.

## Budgets and truncation

The scan counts directories, accepted files, and bytes against the budgets in
`src/contracts.ts:142-148`. Hitting a directory, file-count, or total-byte budget sets
`truncated`, emits `budget-directories` / `budget-files` / `budget-total-bytes`, and stops
the walk (`src/scan.ts:425-465`, `540-561`). A single file over 128 KiB is skipped with
`budget-file-bytes` while the walk continues (`src/scan.ts:447-453`).

A truncated scan is still advertised: the registry records `scan-truncated` and swaps the
partial snapshot, so a huge tree degrades into a smaller list rather than an empty one
(`src/registry.ts:549`).

Diagnostics have two independent budgets: 200 in the scan (`src/scan.ts:44`, `89-98`, ending
in a `diagnostics-truncated` line) and 200 in the refresh outcome (`src/registry.ts:86-91`),
where the overflow is summarised as `truncated: N more diagnostics`. A scan that truncates
still feeds the outcome budget. Post-reload audit lines share that budget in stage order, so
a scan-diagnostic flood can truncate them. No opencode `v2.0.26` surface renders them — see
[architecture.md](architecture.md#failure-model).

## Display caps

| Field | Cap | Behaviour |
|---|---|---|
| name | 80 code points | truncate leading path segments behind `…/`, then cut the last segment (`src/names.ts:32-46`) |
| skill description | 500 code points | cut (`src/registry.ts:116-120`); a command description is stored verbatim |
| scope slug | 24 | cut, then the path hash keeps the ID unique (`src/indexer.ts:48-50`) |
| skill slug | 40 | cut, same (`src/indexer.ts:62-64`) |

All text is sanitised before it reaches the registry: `<`, `>`, `"`, `&`, and control
characters are removed, whitespace is collapsed, and trailing space is trimmed
(`src/names.ts:48-55`).

## What you see, and what you cannot change

| Surface | Behaviour |
|---|---|
| Guidance block | one `<skill>` per entry with id, name, description; `autoinvoke: false` hides the entry here **only** |
| Loader | a loaded skill renders as `<skill_content name="<qualified name>">` with its absolute base directory (`packages/core/src/skill.ts:36-46`) |
| Composer | the `@` menu lists `@<id>`, not the qualified name (`packages/tui/src/component/prompt/autocomplete.tsx:429-431`) |
| Permission prompt | generic body (`Call tool skill`); the exact `nested.<scope>.<skill>` pattern appears in the **Always allow** option (`packages/tui/src/util/permission.ts:139-143`, `154-160`, `packages/tui/src/routes/session/permission.tsx:223-231`) |
| Duplicate | a nested entry is suppressed when its `canonicalPath` equals the **realpath** of a foreign entry's `path` (`src/registry.ts:684-690`, `src/registry.ts:240-256`); while the foreign tier still looks incomplete the check is re-run at 1.5 s and 4 s (`src/registry.ts:39`, `src/registry.ts:806-862`), so a duplicate can survive up to about 4 s then — otherwise it waits for the next refresh |
| Config | the five scan budgets are plugin options on the `opencode.json` entry (object form); display caps and the command-template ceiling stay constants |

`autoinvoke: false` comes from `metadata.opencode/autoinvoke` in the skill's frontmatter, or
from `disable-model-invocation: true` (`src/frontmatter.ts:153-155`,
`src/indexer.ts:194-198`). Such an entry stays registered, stays user-invocable, and loads
normally when you mention it — the guidance block simply does not offer it to the model
(`packages/core/src/skill/instructions.ts:74-81`).

## Scale

Around 50 nested entries — or a measured drop in the model's skill-selection accuracy — is
the point at which on-demand listing should be reconsidered. Today every entry is listed in
the guidance block on every request, so the cost is linear in the number of discovered
skills. That trade-off is a deliberate decision, not an oversight.

## Refresh

Refreshes are bounded rather than instant: one coalescing 250 ms timer collapses a burst of
filesystem events into one refresh, and a prompt-triggered refresh runs at most once per
2000 ms window. Each refresh is a full bounded scan, so a very large tree costs one scan per
burst, not one scan per event. A refresh can also schedule a deferred dedupe check at 1.5 s
and 4 s; that check runs after `refresh()` has returned and never delays it
(`src/registry.ts:788-804`, `src/registry.ts:762-766`, `src/registry.ts:740-767`). Details in
[architecture.md](architecture.md#refresh-model).
