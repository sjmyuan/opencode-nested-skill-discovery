# Limits

Every bound the plugin accepts, what triggers it, and what you see when it bites. The values
are constants in `src/contracts.ts`: the refresh passes no `limits` override, so
`DEFAULT_SCAN_LIMITS` always applies (`src/registry.ts:449-451`), and this release reads no
plugin configuration, so none of them can be changed from `opencode.json`.

## Summary

| Limit | Value | Consequence |
|---|---|---|
| Subproject depth | 5 directories below the location | a depth-6 subproject is invisible |
| Directories scanned | 20,000 | scan stops, partial index advertised |
| Skill files | 5,000 | scan stops, partial index advertised |
| One skill file | 128 KiB | that file is skipped, scan continues |
| Total skill bytes | 16 MiB | scan stops, partial index advertised |
| Diagnostics | 200 in the scan, 200 in the refresh outcome | truncated with a summary line, scan continues |
| Display name | 80 code points | leading path segments dropped behind `…/` |
| Description | 500 code points | truncated |
| Scope slug / skill slug | 24 / 40 characters | slug truncated, hash keeps the ID unique |
| Entry ID | 96 characters declared | structural maximum is 90, so no ID is ever cut |

## Depth

Depth counts directories between the location and the **subproject** — a directory that
carries a marker — not directories between the location and the skill file
(`src/scan.ts:147`, `163-166`; `src/contracts.ts:89-95`).

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
`src/contracts.ts:97-111`):

`node_modules`, `.git`, `.hg`, `.svn`, `.venv`, `venv`, `__pycache__`, `target`, `dist`,
`build`, `.next`, `.cache`, `vendor`

A skill root inside a pruned directory is therefore unreachable — for example
`node_modules/pkg/.opencode/skills/x/SKILL.md` is never discovered, which is what keeps a
copied plugin checkout or an installed dependency from flooding the registry.

## Markers

A marker makes a directory a subproject and gives it a scope token and a name prefix. The
marker kinds are `src/contracts.ts:113-129`:

| Kind | Detected as |
|---|---|
| `opencode-skills` | `.opencode/skills` directory |
| `opencode-skill` | `.opencode/skill` directory |
| `claude-skills` | `.claude/skills` directory |
| `agents-skills` | `.agents/skills` directory |
| `agents-md` | `AGENTS.md` file |
| `claude-md` | `CLAUDE.md` file |
| `git` | any `.git` entry (a worktree file counts) |
| `hg` | a real `.hg` directory |

Markers nest and never stop the walk: the deepest marker owner wins, and its relative path
becomes the entry's name prefix (`src/scan.ts:147`, `src/registry.ts:112`). A symlinked
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

## Budgets and truncation

The scan counts directories, accepted files, and bytes against the budgets in
`src/contracts.ts:89-95`. Hitting a directory, file-count, or total-byte budget sets
`truncated`, emits `budget-directories` / `budget-files` / `budget-total-bytes`, and stops
the walk (`src/scan.ts:323-353`, `398-419`). A single file over 128 KiB is skipped with
`budget-file-bytes` while the walk continues (`src/scan.ts:340-346`).

A truncated scan is still advertised: the registry records `scan-truncated` and swaps the
partial snapshot, so a huge tree degrades into a smaller list rather than an empty one
(`src/registry.ts:453`).

Diagnostics have two independent budgets: 200 in the scan (`src/scan.ts:44`, `89-98`, ending
in a `diagnostics-truncated` line) and 200 in the refresh outcome (`src/registry.ts:75-80`),
where the overflow is summarised as `truncated: N more diagnostics`. A scan that truncates
still feeds the outcome budget. No opencode `v2.0.26` surface renders them — see
[architecture.md](architecture.md#failure-model).

## Display caps

| Field | Cap | Behaviour |
|---|---|---|
| name | 80 code points | truncate leading path segments behind `…/`, then cut the last segment (`src/names.ts:32-46`) |
| description | 500 code points | cut (`src/registry.ts:104-107`) |
| scope slug | 24 | cut, then the path hash keeps the ID unique (`src/indexer.ts:45-47`) |
| skill slug | 40 | cut, same (`src/indexer.ts:49-51`) |

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
| Duplicate | a nested entry is suppressed when its `canonicalPath` equals the **realpath** of a foreign entry's `path` (`src/registry.ts:507-512`, `224-240`); while the foreign tier still looks incomplete the check is re-run at 1.5 s and 4 s (`src/registry.ts:28`, `619-676`), so a duplicate can survive up to about 4 s then — otherwise it waits for the next refresh |
| Config | no plugin options are read in this release; caps and budgets are constants |

`autoinvoke: false` comes from `metadata.opencode/autoinvoke` in the skill's frontmatter, or
from `disable-model-invocation: true` (`src/frontmatter.ts:129-137`,
`src/indexer.ts:183`). Such an entry stays registered, stays user-invocable, and loads
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
(`src/registry.ts:534-543`, `601-617`, `555-581`). Details in
[architecture.md](architecture.md#refresh-model).
