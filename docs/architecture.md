# Architecture

How a workspace's nested subprojects become extra skill entries. Every claim below cites
the merged source in `src/` or the opencode `v2.0.26` runtime it runs in. Limits are
collected in [limits.md](limits.md), loading is in [installation.md](installation.md),
permission rules are in [permissions.md](permissions.md), and the decision of record is in
[design.md](design.md).

## What the plugin changes

The plugin adds entries and removes nothing native. Each refresh scans the location,
replays the result through the single `skill.transform` it registers, publishes commands
through the single `command.transform` it registers, and leaves native, global, and session
skills exactly as they were (`src/registry.ts:361-417`, `src/replay.ts:18-45`,
`src/command-replay.ts:43-90`). The only entry it ever drops is its own duplicate of a nested skill
already registered under another path ([Advertisement](#advertisement)), and it never
registers a second checkout of one repository ([Repo families](#repo-families)). Every entry
it adds carries an ID starting with `nested.` (`src/contracts.ts:131`).

opencode's own discovery reads `<config-dir>/skill` and `<config-dir>/skills` for the
workspace, its ancestor config roots, and the global ones
(`packages/core/src/config/plugin/skill.ts:77-88`). The plugin neither disables nor shadows
those roots: it excludes them from its own scan by realpath (`src/native.ts:28-49`,
`src/indexer.ts:206`) and contributes only what native discovery cannot reach — the
subprojects *below* the location.

## Entry and lifecycle

| Fact | Where |
|---|---|
| `index.ts` default-exports `Plugin.define(definition)` | `index.ts:1-4` |
| Plugin ID is `nested-skill-discovery` | `src/plugin.ts:8` |
| `setup` creates the registry, activates it, and returns a cleanup that disposes it | `src/plugin.ts:23-37` |
| An activation throw is swallowed so `setup` never rejects | `src/plugin.ts:28-32` |

One registry exists per location instance, and a plugin list is a birth argument that stays
immutable for that instance's lifetime (`packages/core/src/plugin/instance.ts:9-17`). A
different directory gets a fresh location context and a fresh activation
(`packages/core/src/worktree.ts:121-126`), so the plugin registers no move hook of its own.

## Activation pipeline

`runRefresh` (`src/registry.ts:479-731`) runs these stages in order. A stage that throws
stops the run: a failure before the snapshot swap keeps the previous snapshot, one after it
leaves the new snapshot in place (see [Failure model](#failure-model)).

| # | Stage | Where |
|---|---|---|
| 1 | Canonicalise the location (`realpath`, falling back to `resolve`) | `src/registry.ts:40-46`, `491-492` |
| 2 | Resolve the native skill roots to exclude | `src/registry.ts:493`, `src/native.ts:37-49` |
| 3 | Scan the location for skill candidates, then reconcile the watcher set from them | `src/registry.ts:538-546`, `src/scan.ts:74-136` |
| 4 | Read, parse, and dedupe candidates, then drop every non-survivor checkout of a repo family | `src/registry.ts:550-566`, `src/indexer.ts:195-248`, `src/family.ts:276-304` |
| 5 | Compose display names and assemble frozen entries | `src/registry.ts:568-570`, `src/registry.ts:111-130` |
| 6 | Group entries by scope token and freeze the snapshot | `src/registry.ts:142-193` |
| 7 | Persist manifest, cache, and version | `src/registry.ts:574-586`, `src/manifest.ts:114-191` |
| 8 | Swap the in-memory snapshot, then `skill.reload()` | `src/registry.ts:580-658` |
| 9 | List the registry, suppress nested duplicates of foreign entries, reload again if anything was suppressed, and schedule the deferred check | `src/registry.ts:668-716`, `src/registry.ts:239-255` |

That table is the skill pipeline. After the skill manifest stage, five **non-fatal** command
stages run around the skill reload: compose the surviving commands' names, drop native
collisions, build the frozen command snapshot, persist and swap it, call `command.reload()`
exactly once, then audit the reloaded listing against that snapshot before reporting a shadow
(`src/registry.ts:591-655`). A failure in any of them is a `command-<stage>:` diagnostic; it
never replaces the previous command snapshot and never blocks the skill reload.

Step 8 swaps before it reloads on purpose: the transform reads the current snapshot, so
the swap must be visible before the host rebuilds its skill list.

Exactly one skill transform (`src/registry.ts:361-380`) and one command transform
(`src/registry.ts:383-417`) are registered per registry, guarded by a `registering` promise.
Refreshes reuse them and never add a second one. A refresh reloads skills once, twice when it
suppresses a duplicate in the same pass, and a deferred check that later suppresses one
reloads on its own after the refresh has returned (`src/registry.ts:853`). Commands reload
exactly once per refresh that reaches the command stages, alongside — never instead of — the
skill reload.

## Discovery bounds

The scan is a sorted pre-order depth-first walk from the location (`src/scan.ts:133-168`).
It stats only; file content is read later, by the indexer (`src/indexer.ts:217-223`).
Depth is counted to the **subproject directory**, not to the skill file: markers nest and
never stop the walk, and the deepest marker owner wins (`src/scan.ts:147`, `165-166`).
Inside an opened skill root the walk has no depth cap (`src/scan.ts:216-246`).

Pruned directory names are skipped before any classification, so a pruned symlink is as
silent as a pruned directory (`src/scan.ts:153-158`, `src/contracts.ts:150-164`). The list
is in [limits.md](limits.md).

## Identity

An entry's ID is `nested.<scopeToken>.<skillToken>` (`src/indexer.ts:185`):

- scope token = `slug(basename(subprojectRealPath), 24)` + `-` + first 8 hex of the SHA-256
  of the subproject's canonical path (`src/indexer.ts:45-47`, `28-37`)
- skill token = `slug(nativeId, 40)` + `-` + first 8 hex of the SHA-256 of the skill file's
  canonical path (`src/indexer.ts:49-51`)

`nativeId` is the file name without `.md`, or the containing directory's name for a
`SKILL.md` (`src/indexer.ts:39-43`). Both slugs are lower-cased `[a-z0-9-]` runs; a name
with no usable characters becomes `x` (`src/indexer.ts:30-37`).

Two consequences matter in practice: an ID never contains anything but `nested.`, two
lower-case slugs, a hyphen, and hex, and it is **path-derived**, so renaming or moving a
subproject changes its scope token and therefore every ID below it. A permission rule
pinned to an exact ID stops matching after such a move ([permissions.md](permissions.md)).

The composed maximum is 90 characters (7 + 24 + 1 + 8 + 1 + 40 + 1 + 8), so the declared
`MAX_ID_LENGTH` of 96 (`src/contracts.ts:132`) is a contract bound rather than a truncation
step (`src/indexer.ts:185` builds the ID without cutting it).

## Repo families

A linked worktree and its main checkout are one repository, so the plugin advertises one
checkout view per family and never registers both — at the checkout root and in every nested
subproject beneath it (`src/family.ts`, ADR R18–R20).

A subproject resolves to its **checkout** first (`src/family.ts:189-206`): with its own
`.git` it is its own checkout, otherwise the nearest ancestor `.git` strictly inside the
location wins, and a subproject with no such ancestor is a foreign checkout. The family is
then derived from the checkout:

| `lstat(<checkout>/.git)` | Family |
|---|---|
| directory | key = realpath of that `.git`, survivor = the checkout |
| file with `gitdir: <C>/worktrees/<n>` | key = `<C>`, survivor = its parent, accepted only when `<C>` is named `.git` and its parent's `.git` resolves to it |
| file with any other target | key = the target, survivor = the checkout, so a submodule stays its own family |
| absent | no family and no diagnostic (a foreign checkout) |

Derivation is `node:fs` only — one memoised `lstat` per ancestor down to the location, one
`lstat` of `<checkout>/.git` per checkout, at most one ≤ 4 KB `.git` read, and `realpath`,
never a `git` subprocess (`src/family.ts:58-131`, `155-231`). The filter then drops every
entry whose checkout is not its family survivor, in scope, whether or not the survivor holds
the same **checkout-relative** path (`src/family.ts:240-284`); it runs after realpath and
native-ID dedupe and before ID assignment (`src/indexer.ts:241-243`), so a suppressed entry is
never minted, never enters the snapshot, cache, or manifest, and no corrective reload is
needed. The rule applies only when the checkout and the survivor are both strict descendants
of the location: a session inside the worktree has the main checkout outside its subtree, so
it still sees the worktree unchanged. Watchers derive from the pre-suppression candidates
(`src/registry.ts:546`), so suppression opens and closes no handle. A `.git` created on an
ancestor is not watched, so that nested subproject starts deduping at the next prompt or move
(Q10).

A `.git` that cannot be read, carries no `gitdir:` line in its first 4 KB, points at a
missing target, or names a common dir that is not its parent's own `.git` disables the rule
for that checkout: the pre-suppression entries are advertised and one
`family: <checkout>: <reason>` diagnostic is recorded, never a failed scan.

## Names

`composeName` joins the subproject's relative path and the skill's native name with `/`
(`src/names.ts:18-30`). Over-long names drop leading path segments behind `…/` until the
path fits, and finally cut the last segment (`src/names.ts:32-46`). `sanitizeText` removes
`<`, `>`, `"`, `&`, and control characters, collapses whitespace, and trims
(`src/names.ts:48-55`). The entry name is capped at 80 code points and the description at
500 in `assembleEntries` (`src/registry.ts:111-130`, `src/contracts.ts:135-136`).

The name is display-only. IDs, permission rules, and dedupe all key on the ID or the
canonical path, never on the name (`src/registry.ts:119-128`, `src/registry.ts:246-252`, `src/indexer.ts:185`).

A description falls back in three tiers: frontmatter `description`, then the first
non-heading, non-blank body line, then `skill <name>` (`src/indexer.ts:96-103`, `181-183`).
The plugin therefore always supplies a description, which matters because opencode drops
description-less entries from the model's guidance block
(`packages/core/src/skill/instructions.ts:74-81`).

## Advertisement

`applyRegistry` replays one immutable snapshot into the transform editor
(`src/replay.ts:18-45`):

- entries are replayed in ID order (`src/replay.ts:25-27`)
- an entry whose ID is already present is skipped, never replaced (`src/replay.ts:29-35`)
- nothing is removed, so native and session skills survive untouched
- a failing `get`/`add` becomes a `replay:` diagnostic instead of an exception
  (`src/replay.ts:32-41`); the buffered diagnostics are drained at the start of the next
  refresh (`src/registry.ts:485-490`)

After the first reload the registry lists what the host actually holds, then compares each
nested entry's `canonicalPath` with the **realpath** of every foreign entry's `path` and
suppresses a match (`src/registry.ts:677-683`, `src/registry.ts:239-255`). Dedupe is two-phase: the immediate
pass runs inside the refresh and emits one `dedupe: <id>` diagnostic per suppressed entry
(`src/registry.ts:685`); when the foreign tier still looks incomplete a deferred check runs at
1.5 s and again at 4 s (`src/registry.ts:38`, `src/registry.ts:781-797`, `src/registry.ts:799-855`). That check is silent on
success and reports only `dedupe-deferred: <reason>` when it throws (`src/registry.ts:852`).
`refresh()` returns without waiting for that check (`src/registry.ts:733-760`), so a
duplicate can survive briefly — up to about 4 s — and then collapse. There is no settle
timeout that reports failure: the deferred check simply re-lists and re-filters.

## Storage model

Three skill keys (`src/contracts.ts:201-204`) and three command keys
(`src/contracts.ts:205-207`):

| Key | Contents |
|---|---|
| `nested/manifest/version` | monotonic counter: `max(current + 1, Date.now())` (`src/manifest.ts:118-130`) |
| `nested/manifest/<scopeToken>` | `{ manifestVersion, scopeToken, directory, entries }` (`src/contracts.ts:24-29`, `src/manifest.ts:142-155`) |
| `nested/subproject/<scopeToken>` | the same grouping with each entry's `content` (`src/manifest.ts:62-69`, `148-166`) |
| `nested/commands/version` | the command store's own counter; it moves only when the command set changes (`src/manifest.ts:345-405`) |
| `nested/commands/manifest/<scopeToken>` | `{ manifestVersion, scopeToken, directory, entries }`, no `template` (`src/manifest.ts:408-413`) |
| `nested/commands/<scopeToken>` | the same grouping plus each entry's `template`, `agent`, `model`, `subagent` (`src/contracts.ts:71-93`, `src/manifest.ts:414-419`) |

A manifest entry is `{ id, canonicalPath, name, description?, autoinvoke? }` and carries no
`content` (`src/manifest.ts:54-60`). The cache entry adds `content`, the
markdown body with the frontmatter block removed (`src/manifest.ts:62-69`,
`src/indexer.ts:191`).

Every successful refresh writes the three skill keys and then prunes them. Pruning scans both
prefixes page by page, keeps the tokens written in this run plus the version key, and removes
a stale record only when its recorded `directory` is inside the location being scanned
(`src/manifest.ts:82-112`, `182-188`). The command store instead compares a canonical
signature and writes nothing at all when the records already match, counter included
(`src/manifest.ts:350-387`). It prunes both command prefixes in-location, and its cache-prefix
prune skips `nested/commands/manifest/` because that prefix is nested inside the cache prefix
(`src/manifest.ts:323-324`, `452-458`). A non-nested location therefore never deletes another
workspace's records, and a record whose token is still active is never touched. Nested
locations share one plugin-id storage, so an outer location's refresh sees an inner location's
records inside its own root and prunes them; a directory bound by two locations has one scope
token, so its record is last-writer-wins on the same key — the record carries no location
field (`src/contracts.ts:24-29`).

The skill cache is written but not read back: no code path calls `storage.get` on
`nested/subproject/<token>`, so nothing is served from storage. ADR R15 and solution §4.7
describe that cache as reloaded on bind; those documents are stale on that point — the only
storage reads in the plugin are the two version counters and the command cache the
change comparison inspects (`src/manifest.ts:337-366`). The manifest is likewise an
audit and diagnostics artifact — it is never a filter for what gets advertised
(`src/registry.ts:479-731` reads only live scan output).

Raw keys are namespaced by the host as `plugin:<hex of the plugin id>:`; the plugin-visible
key is the suffix (`packages/core/src/plugin/host.ts:609-616`). A raw-KV query therefore
matches `LIKE 'plugin:%:nested/%'`.

## Refresh model

Three triggers feed one refresh path. `refresh()` joins an in-flight run instead of
starting a second one, so concurrent triggers cost one scan (`src/registry.ts:733-760`).

| Trigger | Mechanism | Bound |
|---|---|---|
| activation | `setup` → `activate()` (`src/plugin.ts:23-37`) | once per location instance |
| filesystem change | non-recursive `fs.watch` per location root, per subproject with candidates, per skill root, per skill directory, per command root, per command directory (`src/watch.ts`) | one coalescing timer at `DEBOUNCE_MS = 250` (`src/contracts.ts:137`) |
| prompt admission | a `prompt` session hook calling a throttled backstop (`src/backstop.ts:23-54`) | `PROMPT_THROTTLE_MS = 2_000` (`src/contracts.ts:140`), skipped when any refresh just finished |

The debounce is a single timer (`src/registry.ts:315-318`), not a per-event delay: the first
event arms it, later events inside the window are swallowed, so a save burst is one refresh
and a sustained stream yields at most four per second. The backstop awaits an in-flight
refresh instead of starting a second one, so a prompt never waits for two scans.

The watcher set is derived from the **last good scan** and reconciled immediately after it
(`src/registry.ts:546`, `src/registry.ts:420-436`): canonical, deduped, sorted, with pruned segments and
symlinked directories dropped. Each reconciliation closes handles that are no longer in the
set, so a deleted subproject does not leak a watcher.

A debounced event runs the **full** refresh, not a rescan of the changed directory. That is
deliberate: subproject ownership and inherited markers come from the walk rooted at the
location (`src/scan.ts:133-147`), so a subtree scan would compute different scope tokens and
different IDs. The cost is bounded by the debounce and the throttle — one bounded scan is
roughly 0.17 s on the reference workspace.

Watch and hook failures never escape: `syncWatchers` buffers them as `watch: <path>: <code>`
(`src/registry.ts:420-436`) and `ensureBackstop` buffers `hook: <reason>`
(`src/registry.ts:440-467`), both drained into the next outcome (`src/registry.ts:485-490`). The watcher set
advances as soon as the scan succeeds, even if a later stage fails (`src/registry.ts:546`),
so only a failed scan leaves the previous set watched. `dispose()` clears the deferred timers
and the debounce timer, closes every handle, awaits any in-flight refresh with errors
swallowed, then disposes the hook and the transform; it is idempotent
(`src/registry.ts:858-892`). A deferred dedupe check that is still pending can follow a
completed refresh without delaying it (`src/registry.ts:755-759`, `src/registry.ts:733-760`).

Watcher, debounce, and backstop behaviour is implemented in `src/watch.ts` and
`src/backstop.ts` (`deriveWatchTargets` at `src/watch.ts:256-309`, `createDebouncer` at
`56-86`, `createWatchSet` at `101-153`, `createBackstop` at `src/backstop.ts:23-54`) and is
covered by `test/watch-targets.test.ts`, `test/watch-triggers.test.ts`,
`test/backstop.test.ts`, `test/registry-refresh.test.ts`, and
`test/registry-command-refresh.test.ts`. Command candidates join the derivation from the
**pre-suppression** scan result (`src/registry.ts:546`), so a repo-family flip changes which
names publish without opening or closing a handle.

## Failure model

The snapshot boundary is the swap at `src/registry.ts:580`. Everything before it — scan,
index, snapshot assembly, manifest — leaves the **previous** snapshot in place when it
throws. Everything after it — the first reload, the `list`, the dedupe persist and the
corrected reload — returns `ok: false` while the **new** snapshot is already current, so the
advertised list is whatever the last completed step produced.

| Case | Behaviour | Where |
|---|---|---|
| Scan, index, snapshot, or manifest throws | one `<stage>: <reason>` diagnostic, **previous** snapshot kept, `ok: false` | `src/registry.ts:94-105`, `src/registry.ts:538-586` |
| The location is missing or not a directory | empty snapshot persisted and swapped, `scan: … is not a directory`, `ok: false` | `src/registry.ts:495-536` |
| Diagnostics exceed 200 | truncated with `truncated: N more diagnostics` | `src/registry.ts:85-90` |
| Scan diagnostics exceed 200 | truncated with `diagnostics-truncated` | `src/scan.ts:44`, `src/scan.ts:89-98` |
| A budget is hit | `scan-truncated` plus `budget-*`, and the partial index is still swapped | `src/registry.ts:542`, `src/scan.ts:425-465` |
| The first `reload()` throws | diagnostic recorded, `ok: false`, **new** snapshot already swapped | `src/registry.ts:657-658` |
| `list`, the dedupe persist, or the corrected reload throws | `ok: false`, the new (or corrected) snapshot stays current; the next refresh re-evaluates | `src/registry.ts:669`, `src/registry.ts:687-705` |
| Watch or hook registration fails | buffered `watch:` / `hook:` diagnostic drained into the next outcome; other triggers keep working and `setup` still resolves | `src/registry.ts:420-436`, `src/registry.ts:440-467`, `src/registry.ts:485-490`, `src/plugin.ts:28-32` |
| A deferred dedupe check throws | `dedupe-deferred: <reason>` buffered and surfaced on the next outcome; the snapshot is untouched | `src/registry.ts:852` |
| A command stage throws (index, snapshot, persist, reload, audit) | one `command-<stage>:` diagnostic; the previous command snapshot stays on a persist failure, and the single `skill.reload()` still runs | `src/registry.ts:591-655` |
| A command file is malformed, unreadable, or over the budget | dropped with `command-frontmatter:`, `unreadable:` or `command-oversize:`; its siblings still publish | `src/command-snapshot.ts:72-110` |
| A shell interpolation fails during an invocation | that invocation rejects with the joined diagnostics; the registry, the snapshot, and every later invocation are unaffected | `src/command-execute.ts:55-57` |
| A published command never appears | a native name shadows it or a repo family suppresses it before publication, or the reloaded listing holds it under a different description; the audit reports `native-shadow-audit:` and the entry leaves the next snapshot, while an identical description is indistinguishable | `src/registry.ts:639-655`, `src/command-shadow.ts:86-117` |

When the pre-drop stage never ran, the audit is handed `EMPTY_NATIVE_COMMANDS`
(`src/command-audit.ts:5-10`): its `complete: true` asserts only that **no walk happened**, so
nothing is known to be native-owned. It is a marker of that state, not a claim about the
filesystem; a walk that was truncated instead reports `budget-*` and is never treated as
complete.

Diagnostics are readable from the `RefreshOutcome` that `activate()`/`refresh()` return
(`src/registry.ts:195-204`), which also reports `commands` and `commandReloads` next to the
skill `skills`/`reloads` counts. opencode `v2.0.26` renders no plugin log or diagnostic surface,
so a user sees them only through a caller that inspects the outcome; the observable
fallbacks are the guidance block, the `@` menu, and storage keys.

## Component map

| File | Responsibility |
|---|---|
| `index.ts` | default export for the host loader |
| `src/plugin.ts` | plugin ID, `setup`, cleanup, empty snapshot |
| `src/contracts.ts` | entry/snapshot/storage shapes, caps, budgets, prune list, markers, command root kinds, candidate and command-snapshot shapes |
| `src/scan.ts` | bounded DFS, markers, skill roots, command roots and candidates, budgets, refusals |
| `src/frontmatter.ts` | minimal frontmatter reader: `name`, `description`, `metadata.opencode/autoinvoke`, `disable-model-invocation`; the additive command reader (`description`, `agent`, `model`, `subagent`/`subtask`, verbatim template) |
| `src/family.ts` | repo-family derivation from `.git` and the survivor filter |
| `src/indexer.ts` | ranks, dedupes, parses candidates; drops non-survivor checkouts; derives IDs and names |
| `src/names.ts` | qualified display names, truncation, sanitisation |
| `src/native.ts` | the native skill roots to exclude |
| `src/command-native.ts` | the native command names visible from a location: ancestor and global walks, shared budgets, no content read |
| `src/command-audit.ts` | the post-reload composition: the published set taken from the snapshot, one `command.list()`, handed to the shadow tracker |
| `src/command-shadow.ts` | native precedence for command names: pre-drop, post-refresh audit, cross-pass denial ledger |
| `src/command-names.ts` | command-name composition: `composeCommandName` joins `subproject:command`, `composeCommandNames` resolves first-wins collisions, `createNameLedger` silences repeats, and `QualifiedCommand.publishedName` is the key |
| `src/command-snapshot.ts` | reads each qualified command's content, drops a malformed, unreadable or oversized file, and freezes the per-subproject command snapshot |
| `src/command-replay.ts` | add-only, synchronous, I/O-free command replay; `execute` resolves its entry from the live snapshot |
| `src/command-expand.ts` | native-parity template expansion: tokenise → `$N` with the highest index absorbing the tail → `$ARGUMENTS` → append → trim → shell; the text half is pure and the shell pass is injected |
| `src/command-shell.ts` | `{env, platform}` to a shell target, the family's argv shape, the production runner, and the injectable `ProcessRunner` |
| `src/command-model.ts` | the one place the stored `model` string and the routing `Model.Ref` meet |
| `src/command-family.ts` | command candidates through the delivered repo-family survivor filter |
| `src/command-execute.ts` | invocation routing: expansion, agent and model selection, child creation for a subagent, prompt forwarding |
| `src/registry.ts` | the refresh pipeline, skill and command transform registration, snapshot swaps, shutdown |
| `src/manifest.ts` | skill and command version, manifest and cache writes, location-scoped prune |
| `src/replay.ts` | add-only snapshot replay into the transform editor |
| `src/watch.ts` | watcher set derivation, handle reconciliation, debounce timer, node factory |
| `src/backstop.ts` | throttled prompt-triggered refresh |
