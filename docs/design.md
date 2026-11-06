# Design

Why the plugin works the way it does, and where the decision of record lives. This page
summarises the accepted decisions; it is not a second specification. The behaviour itself is
described in [architecture.md](architecture.md), bounded in [limits.md](limits.md), and
configured in [permissions.md](permissions.md).

## The decision in one paragraph

Nested subprojects are advertised through a **union**: one eager, bounded, namespaced index
is built per bound location, replayed into opencode's own skill registry through a single
add-only `skill.transform`, and refreshed by watchers plus a throttled prompt backstop.
Native, global, and session skills are never filtered, replaced, or removed — the plugin only
appends entries whose IDs start with `nested.`. A nested skill therefore competes for the
model's attention as a peer of a native skill, with a subproject-qualified display name and a
stable, collision-free ID as its key.

## Decisions of record

| ADR | Title | Decides |
|---|---|---|
| discovery | Nested Skill Discovery and Registration | the bounded DFS, subproject markers, path-hash IDs, qualified names, and the refresh model |
| exposure | Union Skill Advertisement | one union list rather than per-session filtering, and the add-only transform |

The two ADRs are accepted and are not re-litigated by the documentation.

## Where the details live

The solution document carries the read-only artefacts behind these decisions: the business
context and accepted limits (§1), the C4 topology (§2), the interaction flows (§3), the API
and event schemas including the ID and storage shapes (§4), the RAID analysis (§8), and the
RACI matrix (§9). Storage (§4.7) is the one place where the solution has drifted from the
code: the cache is written with each entry's content, and nothing reads it back — see
[architecture.md](architecture.md#storage-model).

## Divergences recorded here

- The solution's cache example omits `content`; the code writes it (`src/manifest.ts:59-66`).
- The solution and the discovery ADR describe the cache as reloaded on bind; no code path
  reads `nested/subproject/<token>`, so the cache is write-only today.
- The upstream permissions page says a `skill` rule matches the skill name; at the pinned
  runtime it matches the ID ([permissions.md](permissions.md)).
- The discovery ADR's R10 manifest shape is `{ id, canonicalPath, name, autoinvoke }`; the
  code writes `{ id, canonicalPath, name, description?, autoinvoke? }` — `description` is
  optional and present whenever the indexer derived one (`src/manifest.ts:51-57`).
