# Architecture

How a workspace's nested subprojects become extra skill entries. Every claim below cites
the merged source in `src/` or the opencode `v2.0.26` runtime it runs in. Limits are
collected in [limits.md](limits.md), loading is in [installation.md](installation.md), and
permission rules are in [permissions.md](permissions.md).

## What the plugin changes

The plugin adds entries and removes nothing. Each refresh scans the location, replays the
result through the single `skill.transform` it registers, and leaves native, global, and
session skills exactly as they were (`src/registry.ts:242-261`, `src/replay.ts:18-45`). Every entry it adds carries an ID starting with `nested.`
(`src/contracts.ts:78`).

opencode's own discovery reads `<config-dir>/skill` and `<config-dir>/skills` for the
workspace, its ancestor config roots, and the global ones
(`packages/core/src/config/plugin/skill.ts:77-88`). The plugin neither disables nor shadows
those roots: it excludes them from its own scan by realpath (`src/native.ts:28-49`,
`src/indexer.ts:191`) and contributes only what native discovery cannot reach — the
subprojects *below* the location.

## Entry and lifecycle

| Fact | Where |
|---|---|
| `index.ts` default-exports `Plugin.define(definition)` | `index.ts:1-4` |
| Plugin ID is `nested-skill-discovery` | `src/plugin.ts:6` |
| `setup` creates the registry, activates it, and returns a cleanup that disposes it | `src/plugin.ts:20-32` |
| An activation throw is swallowed so `setup` never rejects | `src/plugin.ts:23-27` |

One registry exists per location instance. A move binds a new instance and a fresh
activation, so the plugin registers no move hook of its own.

## Activation pipeline

`runRefresh` (`src/registry.ts:263-372`) runs these stages in order. A stage that throws
stops the run and keeps the previous snapshot (see [Failure model](#failure-model)).

| # | Stage | Where |
|---|---|---|
| 1 | Canonicalise the location (`realpath`, falling back to `resolve`) | `src/registry.ts:24-30`, `267-268` |
| 2 | Resolve the native skill roots to exclude | `src/registry.ts:269`, `src/native.ts:37-49` |
| 3 | Scan the location for skill candidates | `src/registry.ts:299-304`, `src/scan.ts:74-136` |
| 4 | Read, parse, and dedupe candidates into indexed skills | `src/registry.ts:306-310`, `src/indexer.ts:180-231` |
| 5 | Compose display names and assemble frozen entries | `src/registry.ts:312-316`, `58-77` |
| 6 | Group entries by scope token and freeze the snapshot | `src/registry.ts:89-140` |
| 7 | Persist manifest, cache, and version | `src/registry.ts:318-323`, `src/manifest.ts:110-187` |
| 8 | Swap the in-memory snapshot, then `skill.reload()` | `src/registry.ts:325-328` |
| 9 | List the registry, suppress entries native discovery already owns, reload once more if anything was suppressed | `src/registry.ts:331-362`, `170-186` |

Step 8 swaps before it reloads on purpose: the transform reads the current snapshot, so
the swap must be visible before the host rebuilds its skill list.

Exactly one transform is registered per registry, guarded by a `registering` promise
(`src/registry.ts:242-261`). Refreshes reuse it; they never add a second one and never
call `reload()` more than twice (the second only after a dedupe correction).

## Discovery bounds

The scan is a sorted pre-order depth-first walk from the location (`src/scan.ts:133-168`).
It stats only; file content is read later, by the indexer (`src/indexer.ts:200-206`).
Depth is counted to the **subproject directory**, not to the skill file: markers nest and
never stop the walk, and the deepest marker owner wins (`src/scan.ts:147`, `165-166`).
Inside an opened skill root the walk has no depth cap (`src/scan.ts:216-246`).

Pruned directory names are skipped before any classification, so a pruned symlink is as
silent as a pruned directory (`src/scan.ts:153-158`, `src/contracts.ts:94-108`). The list
is in [limits.md](limits.md).

## Identity

An entry's ID is `nested.<scopeToken>.<skillToken>` (`src/indexer.ts:170`):

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
`MAX_ID_LENGTH` of 96 (`src/contracts.ts:79`) is a contract bound rather than a truncation
step (`src/indexer.ts:170` builds the ID without cutting it).

## Names

`composeName` joins the subproject's relative path and the skill's native name with `/`
(`src/names.ts:18-30`). Over-long names drop leading path segments behind `…/` until the
path fits, and finally cut the last segment (`src/names.ts:32-46`). `sanitizeText` removes
`<`, `>`, `"`, `&`, and control characters, collapses whitespace, and trims
(`src/names.ts:48-55`). The entry name is capped at 80 code points and the description at
500 in `assembleEntries` (`src/registry.ts:61-70`, `src/contracts.ts:82-83`).

The name is display-only. IDs, permission rules, and dedupe all key on the ID or the
canonical path, never on the name (`src/registry.ts:76`, `178`, `src/indexer.ts:170`).

A description falls back in three tiers: frontmatter `description`, then the first
non-heading, non-blank body line, then `skill <name>` (`src/indexer.ts:96-103`, `166-168`).
The plugin therefore always supplies a description, which matters because opencode drops
description-less entries from the model's guidance block
(`packages/core/src/skill/instructions.ts:74-79`).

## Advertisement

`applyRegistry` replays one immutable snapshot into the transform editor
(`src/replay.ts:18-45`):

- entries are replayed in ID order (`src/replay.ts:25-27`)
- an entry whose ID is already present is skipped, never replaced (`src/replay.ts:29-35`)
- nothing is removed, so native and session skills survive untouched
- a failing `get`/`add` becomes a `replay:` diagnostic instead of an exception
  (`src/replay.ts:32-41`), which the next refresh drains into its outcome
  (`src/registry.ts:266`)

After the first reload the registry lists what the host actually holds, and a nested entry
whose canonical path collides with a foreign entry is suppressed (`src/registry.ts:334-362`,
`src/registry.ts:170-186`). A collision therefore survives exactly one rebuild: it is added,
reloaded, detected, removed, and reloaded again, with a `dedupe: <id>` diagnostic.

## Storage model

Three logical keys (`src/contracts.ts:138-142`):

| Key | Contents |
|---|---|
| `nested/manifest/version` | monotonic counter: `max(current + 1, Date.now())` (`src/manifest.ts:114-126`) |
| `nested/manifest/<scopeToken>` | `{ manifestVersion, scopeToken, directory, entries }` (`src/contracts.ts:24-29`, `src/manifest.ts:138-151`) |
| `nested/subproject/<scopeToken>` | the same grouping with each entry's `content` (`src/manifest.ts:59-66`, `144-162`) |

A manifest entry is `{ id, canonicalPath, name, description?, autoinvoke? }` and carries no
`content` (`src/manifest.ts:51-57`). The cache entry adds `content`, the
markdown body with the frontmatter block removed (`src/manifest.ts:59-66`,
`src/indexer.ts:176`).

Every successful refresh writes the three keys and then prunes. Pruning scans both prefixes page by
page, keeps the tokens written in this run plus the version key, and removes a stale record
only when its recorded `directory` is inside the location being scanned
(`src/manifest.ts:79-108`, `178-184`). Another workspace's records are therefore never
deleted, and a record whose token is still active is never touched.

The cache is written but not read back in this release: no code path calls `storage.get` on
`nested/subproject/<token>`, so nothing is served from storage. The manifest is likewise an
audit and diagnostics artifact — it is never a filter for what gets advertised
(`src/registry.ts:263-372` reads only live scan output).

Raw keys are namespaced by the host as `plugin:<hex of the plugin id>:`; the plugin-visible
key is the suffix (`packages/core/src/plugin/host.ts:609-616`). A raw-KV query therefore
matches `LIKE 'plugin:%:nested/%'`.

## Refresh model

Three triggers feed one refresh path. `refresh()` joins an in-flight run instead of
starting a second one, so concurrent triggers cost one scan (`src/registry.ts:374-393`).

| Trigger | Mechanism | Bound |
|---|---|---|
| activation | `setup` → `activate()` (`src/plugin.ts:20-32`) | once per location instance |
| filesystem change | one non-recursive `fs.watch` per location root, per subproject directory that holds candidates, per skill-root directory, and per skill's own directory (`src/watch.ts`) | one coalescing timer at `DEBOUNCE_MS = 250` (`src/contracts.ts:84`): the first event arms it, later events are swallowed, so a save burst is one refresh and a sustained stream yields at most four per second |
| prompt admission | a `prompt` session hook calling a throttled backstop (`src/backstop.ts`) | one refresh per 2000 ms window; skipped entirely when any refresh finished inside the window, and an in-flight refresh is awaited rather than duplicated |

The watcher set is derived from the **last good scan**: canonical, deduped, sorted, with
pruned segments and symlinked directories dropped. Each reconciliation closes handles that
are no longer in the set, so a deleted subproject does not leak a watcher.

A debounced event runs the **full** refresh, not a rescan of the changed directory. That is
deliberate: subproject ownership and inherited markers come from the walk rooted at the
location (`src/scan.ts:133-147`), so a subtree scan would compute different scope tokens and
different IDs. The cost is bounded by the debounce and the throttle — one bounded scan is
roughly 0.17 s on the reference workspace.

Watch and hook failures never escape: they are buffered as `watch: <path>: <code>` or
`hook: <reason>` and surface on the next outcome, and a failed refresh keeps both the
previous snapshot and the previous watcher set. `dispose()` clears the timer, closes every
handle, awaits any in-flight refresh with errors swallowed, and disposes the hook and the
transform; it is idempotent.

Watcher, debounce, and backstop behaviour ships in `src/watch.ts` and `src/backstop.ts` and
is covered by `test/watch-targets.test.ts`, `test/watch-triggers.test.ts`,
`test/backstop.test.ts`, and `test/registry-refresh.test.ts`. The remaining sections cite
code that predates that refresh work.

## Failure model

| Case | Behaviour | Where |
|---|---|---|
| A stage throws | one `<stage>: <reason>` diagnostic, previous snapshot kept, `ok: false` returned | `src/registry.ts:41-52` |
| The location is missing or not a directory | empty snapshot persisted, `scan: … is not a directory`, `ok: false` | `src/registry.ts:271-297` |
| Diagnostics exceed 200 | truncated with `truncated: N more diagnostics` | `src/registry.ts:22-37` |
| Scan diagnostics exceed 200 | truncated with `diagnostics-truncated` | `src/scan.ts:44`, `89-98` |
| A budget is hit | `scan-truncated` plus `budget-*`, and the partial index is still swapped | `src/registry.ts:303`, `src/scan.ts:323-355` |
| `reload()` throws | diagnostic recorded, `ok: false`, previous snapshot already swapped | `src/registry.ts:325-328` |
| Watch or hook registration fails | buffered diagnostic, other triggers still work, `setup` still resolves | `src/registry.ts:242-261`, `src/plugin.ts:23-27` |

Diagnostics are readable from the `RefreshOutcome` that `activate()`/`refresh()` return
(`src/registry.ts:142-149`). opencode `v2.0.26` renders no plugin log or diagnostic surface,
so a user sees them only through a caller that inspects the outcome; the observable
fallbacks are the guidance block, the `@` menu, and storage keys.

## Component map

| File | Responsibility |
|---|---|
| `index.ts` | default export for the host loader |
| `src/plugin.ts` | plugin ID, `setup`, cleanup, empty snapshot |
| `src/contracts.ts` | entry/snapshot/storage shapes, caps, budgets, prune list, markers |
| `src/scan.ts` | bounded DFS, markers, skill roots, budgets, refusals |
| `src/frontmatter.ts` | minimal frontmatter reader: `name`, `description`, `metadata.opencode/autoinvoke`, `disable-model-invocation` |
| `src/indexer.ts` | ranks, dedupes, parses candidates; derives IDs and names |
| `src/names.ts` | qualified display names, truncation, sanitisation |
| `src/native.ts` | the native skill roots to exclude |
| `src/registry.ts` | the refresh pipeline, transform registration, snapshot swap, shutdown |
| `src/manifest.ts` | version, manifest and cache writes, location-scoped prune |
| `src/replay.ts` | add-only snapshot replay into the transform editor |
| `src/watch.ts` | watcher set derivation, handle reconciliation, debounce timer, node factory |
| `src/backstop.ts` | throttled prompt-triggered refresh |
