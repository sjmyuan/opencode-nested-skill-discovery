# Limits

Every bound the plugin accepts, what triggers it, and what you see when it bites. The five
scan budgets are **defaults** declared in `src/contracts.ts:179-185` and each one is
overridable from the plugin entry's `options` object: the registry resolves them once at
construction (`src/options.ts:34-51`, `src/registry.ts:360`) and hands the same object to the
skill scan (`src/registry.ts:635-642`) and to the native command-name walk
(`src/registry.ts:766`). An auto-discovered directory plugin receives `{}`, so zero-config
behaviour is the defaults — apart from the raised directory budget and the lowered depth below.

## Summary

| Limit | Value | Consequence |
|---|---|---|
| Subproject depth | 2 directories below the location (default) | a depth-3 subproject is invisible at the default |
| Directories scanned | 100,000 (default) | scan stops, partial index advertised |
| Skill, command, agent and config-document files | 5,000 (default) | scan stops, partial index advertised |
| One skill, command, agent or config-document file | 128 KiB (default) | that file is skipped, scan continues |
| Total skill, command, agent and config-document bytes | 16 MiB (default) | scan stops, partial index advertised |
| Diagnostics | 200 in the scan, 200 in the refresh outcome | truncated with a summary line, scan continues |
| Native command-name walk | shares the directory and file budgets above; reads no content | a truncated walk stops early and reports `budget-*`; its `complete` flag is computed and never surfaced (`src/command-native.ts:129-133`) |
| Display name | 80 code points | leading path segments dropped behind `…/` |
| Command name | 160 code points (`MAX_COMMAND_NAME_LENGTH`, `src/command-names.ts`) | never truncated: a longer name is kept whole and logged as `name-too-long:`, while skill display names still cut at 80 |
| Skill description | 500 code points | truncated; a command description is stored verbatim and never capped (native parity) |
| Scope slug / skill slug | 24 / 40 characters | slug truncated, hash keeps the ID unique |
| Entry ID | 96 characters declared | structural maximum is 90, so no ID is ever cut |
| Command template | the file body, so the same 128 KiB per-file limit | the whole command file is skipped with `command-oversize:`; the command snapshot adds no new budget |

The command template is the file body after the closing fence, so it is bounded by the shared
128 KiB per-file limit (`src/contracts.ts:179-185`) rather than by a budget of its own. The
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
| `maxDepth` | 2 | subproject directories below the location |
| `maxDirectories` | 100,000 | directories visited by the scan, and by the native command walk |
| `maxFiles` | 5,000 | admitted skill, command, agent and config-document files, both walks |
| `maxFileBytes` | 131,072 (128 KiB) | one skill, command, agent or config-document file |
| `maxTotalBytes` | 16,777,216 (16 MiB) | all admitted skill, command, agent and config-document bytes |

Resolution is fail-safe per key (`src/options.ts:34-51`): a value that is not a finite number
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
  checkout behaves exactly as before, at the raised 100,000 directory budget,
  and at the lowered depth default.

## Depth

Depth counts directories between the location and the **subproject** — a directory that
carries a marker — not directories between the location and the skill file
(`src/scan.ts:198`, `213`; `src/contracts.ts:146-152`). The cap is the `maxDepth`
option, defaulting to 2:

- a subproject at depth 2 is discovered at the default, and its `SKILL.md` may sit many
  levels deeper (`test/scan.test.ts:213-224`)
- a subproject at depth 3 is invisible at the default, silently and without a diagnostic
  (`test/scan.test.ts:226-235`)
- inside an opened skill root the walk is unbounded, so
  `A/.opencode/skills/a/b/c/d/e/f/SKILL.md` is still found (`test/scan.test.ts:248-260`)

The location itself is a depth-0 subproject: skills directly under
`<location>/.opencode/skills` are discovered with an empty subproject path
(`test/scan.test.ts:285-295`).

## Pruned directories

The walk skips these names at every level, before classifying the entry, so a pruned symlink
is skipped as silently as a pruned directory (`src/scan.ts:202`,
`src/contracts.ts:187-201`):

`node_modules`, `.git`, `.hg`, `.svn`, `.venv`, `venv`, `__pycache__`, `target`, `dist`,
`build`, `.next`, `.cache`, `vendor`

A skill root inside a pruned directory is therefore unreachable — for example
`node_modules/pkg/.opencode/skills/x/SKILL.md` is never discovered, which is what keeps a
copied plugin checkout or an installed dependency from flooding the registry.

## Markers

A marker makes a directory a subproject and gives it a scope token and a name prefix. The
marker kinds are `src/contracts.ts:249-257`:

| Kind | Detected as |
|---|---|
| `opencode-skills` | `.opencode/skills` directory |
| `opencode-skill` | `.opencode/skill` directory |
| `claude-skills` | `.claude/skills` directory |
| `agents-skills` | `.agents/skills` directory |
| `opencode-command` | `.opencode/command` directory |
| `opencode-commands` | `.opencode/commands` directory |
| `opencode-project` | an `opencode.json`, `opencode.jsonc`, or `.opencode` entry in the directory listing the walk already holds — never a directory named `.opencode` itself |
| `agents-md` | `AGENTS.md` file |
| `claude-md` | `CLAUDE.md` file |
| `git` | any `.git` entry (a worktree file counts) |
| `hg` | a real `.hg` directory |

Markers nest and never stop the walk: the deepest marker owner wins, and its relative path
becomes the entry's name prefix (`src/scan.ts:189`, `src/registry.ts:128`). A symlinked
skill-root directory is not a marker and is not followed. The project marker is a name test
on the `Dirent` list the walk already holds (ADR agent A2), so it costs no extra system call
per directory. The marker never reads a document: the *content* of a subproject's config
documents is read at the index stage, by `src/agent-config.ts`.

Agent roots are `<subproject>/.opencode/{agent,agents}`: every `.md` file at any depth
inside one, with no depth cap once the root is opened (ADR agent A1, A12). The location's own
`.opencode/{agent,agents}` belongs to native discovery, is never scanned here, and a file
whose realpath sits in a native agent root is skipped silently.

## Config documents

A subproject that owns itself and is a strict descendant also contributes its config
documents: `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json` and
`.opencode/opencode.jsonc` (ADR agent A3). The location's own four belong to native
discovery and are never collected. A symlinked document is refused, not followed, with one
`config-symlink:` line — and so is a document whose realpath leaves `d`: a linked `.opencode`
cannot contribute a document from outside the subproject.

The walk only stats them; the index stage reads them. Reading mirrors native for `{env:VAR}`
— substituted raw, then re-substituted with the JSON-escaped value when the raw pass leaves
the document unparseable — and the document is parsed as JSONC. Only three keys are read —
`agents`, the document's own top-level `permissions`, and `default_agent`
(`src/agent-config.ts:60-63`). Every other key is ignored silently.

`{file:path}` is confined, not trusted. A reference resolves only inside the realpath of the
marked directory `d`: a `~`-leading or absolute token, a relative escape, a missing, broken
or non-regular target, and a realpath that leaves `d` each substitute empty with one
`agent-skip: <doc>: file-ref <token> outside-root` line, and none of them is ever opened — a
lexical refusal costs no system call. A symlink whose realpath stays inside `d` substitutes
like a regular file; an outward one, or one behind an intermediate directory symlink that
points outside, is refused (ADR agent A10). Two caps bound the content, both taken from the
R8 option values and counted per document: a target larger than `maxFileBytes` is
`cap-file`, and a running total past `maxTotalBytes` is `cap-total`. Neither is charged to
the scan budget, and each token costs at most one read per document — the escaped retry
reuses it. This inverts native's trust direction (an ancestor reading a descendant's files),
so substituted text is untrusted prompt and display text, sanitized downstream.

Merging follows native document order — `opencode.json` < `opencode.jsonc` <
`.opencode/opencode.json` < `.opencode/opencode.jsonc` < agent files sorted
(`src/contracts.ts:226-242`). A field applies when the source sets it, so a later source
overrides and an absent field never erases one; `permissions` append and `request` keys
assign. One entry remains per (subproject, native name), the first source owns the token, and
a merge emits one `agent-merge: <name>` line (`src/agent-index.ts:105-205`).

`default_agent` is never applied: it is decoded only to emit one
`agent-default-ignored: <document>` line. A document's read set is checked in a fixed order
— the `agents` shape, the top-level `permissions`, `default_agent` — and the first failure
drops the document, naming the field whose rules are lost. One bad `agents.<key>` is not a
document failure: it drops that key with `agent-skip: <doc>: entry <key> schema` and keeps
its siblings and the document's top-level rules (ADR agent A15). An unreadable or malformed
document drops whole. A pre-V2 agent file is skipped with `agent-skip: legacy …` and never
migrated (`src/agent-decode.ts:51-68`).

| Line | Meaning |
|---|---|
| `agent-skip: unreadable <rel>: <CODE>` | the document or agent file could not be read |
| `agent-skip: malformed <rel>` | the document is not valid JSONC |
| `agent-skip: <doc>: file-ref <token> outside-root` | the reference leaves the marked directory, or its target is missing, broken or not a regular file; it substitutes empty and is never read |
| `agent-skip: <doc>: file-ref <token> cap-file` | the target is larger than `maxFileBytes` |
| `agent-skip: <doc>: file-ref <token> cap-total` | the document's running total would pass `maxTotalBytes` |
| `agent-skip: <doc>: entry <key> schema` | one `agents` key failed; its siblings and the document's rules survive |
| `agent-skip: <doc>: agents schema` | `agents` is not a map; the document drops |
| `agent-skip: <doc>: permissions schema` | the top-level `permissions` do not decode; the document and its ruleset are lost |
| `agent-skip: <doc>: default_agent schema` | `default_agent` does not decode; the document drops |
| `agent-skip: legacy <rel>` | pre-V2 agent frontmatter; skipped, never migrated |
| `agent-skip: markdown <rel>` | agent frontmatter that never parses, even after the sanitize retry |
| `agent-default-ignored: <rel>` | the document sets `default_agent`; never applied |
| `agent-field: <rel> ignored <key,…>` | a non-legacy agent file carries an unknown key |
| `agent-merge: <name> (<rel> + …)` | one per merged native name, sources in native order |
| `agent-index: <reason>` | the agent stage threw; the last good agent list and payload stay published and the refresh still succeeds |
| `agent-skip: disabled <rel>` | the source is disabled; never registered |
| `agent-skip: id-held <rel>` | the host map already held this ID before the transform registered |
| `agent-skip: shadowed <rel>` | a previous audit held this ID out; the entry is omitted from the map |
| `agent-request: <id>` | one per admitted agent that carries a `request` overlay |
| `agent-shadow-audit: <id>` | the reloaded entry did not match the snapshot; held out of the next |
| `agent-seed: <reason>` | the pre-registration listing read threw; registration is still attempted |
| `agent-register: <reason>` | the transform registration rejected; reported once, and the next refresh retries it |
| `agent-replay: <id>: <reason>` | one entry failed to replay; its siblings still applied |
| `agent-replay: payload: <reason>` | the whole payload failed to replay; nothing is applied and the transform never rethrows, so the group stays enabled |
| `agent-reload: <reason>` | the agent reload threw; the map keeps whatever the host built |
| `agent-audit: <reason>` | the post-reload listing read threw; the published map stays |
| `config-symlink: <rel>` | a config document is a symlink, or resolves outside its subproject; refused, never opened |

`<doc>` is the document's location-relative POSIX path, the `<rel>` of the other rows.
`<token>` is the literal `{file:…}` token as written, unexpanded; `<key>` is the `agents` map
key verbatim — it may contain `/` and is never treated as a path. Both sources reach the host
map through one early `ctx.agent.transform`: an admitted entry is inserted only when the map
does not already hold its ID, the location's own rules are appended after ours, and no entry is
ever removed — a held-out ID leaves the next snapshot by omission, after one reload. Each of
`mode` and `hidden` is inherited from a same-named agent already in the runtime registry when
the entry does not author it — a builtin such as `general`, or a host/config agent the
pre-registration listing carries — and otherwise falls back to `primary` and visible; an
authored value always wins.

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
  (`src/watch.ts:272-341`, `test/registry-command-refresh.test.ts`).
- Residual: a worktree of a **submodule** (`.git/modules/<n>/worktrees/<wt>`) cannot name a
  survivor, so that pair still double-registers (Q8).
- Residual: deleting the main checkout's `.git` republishes the hidden worktree at the next
  rescan (Q9).

## Candidate files

- directly under a skill root, any `*.md` file
- below that, only `SKILL.md` (`src/scan.ts:333-335`)

A nested `README.md` inside an open skill root is therefore not a skill.

## Refusals

Symlinks are inspected, never followed blindly (`src/scan.ts:280-299`, `436-451`):

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
`src/contracts.ts:179-185`. Hitting a directory, file-count, or total-byte budget sets
`truncated`, emits `budget-directories` / `budget-files` / `budget-total-bytes`, and stops
the walk (`src/scan.ts:562-602`, `771-776`). A single file over 128 KiB is skipped with
`budget-file-bytes` while the walk continues (`src/scan.ts:584-590`).

A truncated scan is still advertised: the registry records `scan-truncated` and swaps the
partial snapshot, so a huge tree degrades into a smaller list rather than an empty one
(`src/registry.ts:644`).

Diagnostics have two independent budgets: 200 in the scan (`src/scan.ts:70`, `125-133`, ending
in a `diagnostics-truncated` line) and 200 in the refresh outcome (`src/registry.ts:91-96`),
where the overflow is summarised as `truncated: N more diagnostics`. A scan that truncates
still feeds the outcome budget. Post-reload audit lines share that budget in stage order, so
a scan-diagnostic flood can truncate them. No opencode `v2.0.26` surface renders them — see
[architecture.md](architecture.md#failure-model).

## Display caps

| Field | Cap | Behaviour |
|---|---|---|
| name | 80 code points | truncate leading path segments behind `…/`, then cut the last segment (`src/names.ts:32-46`) |
| skill description | 500 code points | cut (`src/registry.ts:121-125`); a command description is stored verbatim |
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
| Duplicate | a nested entry is suppressed when its `canonicalPath` equals the **realpath** of a foreign entry's `path` (`src/registry.ts:871-873`, `src/registry.ts:247-263`); while the foreign tier still looks incomplete the check is re-run at 1.5 s and 4 s (`src/registry.ts:44`, `src/registry.ts:977-1052`), so a duplicate can survive up to about 4 s then — otherwise it waits for the next refresh |
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
(`src/registry.ts:909`, `src/registry.ts:927-955`, `src/registry.ts:986-990`). Details in
[architecture.md](architecture.md#refresh-model).
