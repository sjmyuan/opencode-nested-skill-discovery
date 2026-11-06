# opencode-nested-skill-discovery

An opencode plugin that discovers skills in the nested subprojects of a workspace and
advertises them as `nested.`-prefixed entries alongside the native ones. Native, global, and
session skills are never modified: the plugin only appends entries through the single
`skill.transform` it registers.

Workspaces that contain several checkouts — a monorepo, a directory of service repos, a
folder of client projects — usually keep a `SKILL.md` per subproject that opencode never
sees, because its native discovery reads the skill directories of the workspace and its
ancestors, never the subprojects inside it
(`packages/core/src/config/plugin/skill.ts:77-88`). This plugin scans one bounded level-set
below the workspace, gives every skill a qualified, collision-free identity, and keeps the
list current while you work.

## Status

Delivered and covered by the test suite: bounded discovery, stable IDs and qualified
display names, add-only advertisement, manifest/cache persistence, and refresh — watchers
derived from the last scan, a coalescing debounce, and a throttled prompt backstop.
Outstanding: an end-to-end smoke run against a live opencode workspace; every behaviour is
currently proven by unit and integration tests rather than by a manual session.

## Requirements

- opencode `v2.0.26` (`@opencode/plugin` is pinned to `2.0.26`, `package.json:12-16`)
- Bun, provided by opencode — the plugin runs inside the host
- Node 25 + npm for the development toolchain only

The plugin is not published to npm (`package.json:4`) and needs no `npm install` to load.

## Install

Symlink this checkout into a workspace's plugin directory:

```sh
mkdir -p <workspace>/.opencode/plugins
ln -s /Users/ganggang/work/opencode-nested-skill-discovery \
      <workspace>/.opencode/plugins/nested-skill-discovery
```

Or copy it there for a fixed snapshot (`cp -R`). opencode scans both `.opencode/plugin` and
`.opencode/plugins`, accepts a file or a directory, and resolves a directory to
`<dir>/index.ts` — this repository's entry point. No dependencies need to be installed:
opencode supplies `@opencode/plugin` and `effect` at runtime.

Full instructions, including the `opencode.json` form and how to verify the load, are in
[docs/installation.md](docs/installation.md).

## What the model sees

Once per refresh the plugin scans, replays its snapshot, and reloads the registry. The
model's guidance block then lists one entry per skill
(`packages/core/src/skill/instructions.ts:16-22`):

```xml
<skill>
  <id>nested.vscode-1a2b3c4d.deploy-9f8e7d6c</id>
  <name>vscode/deploy</name>
  <description>Ship the extension to the marketplace</description>
</skill>
```

The `id` is the addressable key; the `name` is display-only and derived from the subproject
path. Loading a skill produces the usual `<skill_content name="vscode/deploy">` block with
the skill's absolute base directory (`packages/core/src/skill.ts:36-46`).

Entries marked `autoinvoke: false` stay registered and stay user-invocable, but are not
offered to the model in that block.

## What you see

- the qualified name (`vscode/deploy`) in the guidance block, the tool result, and the
  loaded content
- `@nested.vscode-1a2b3c4d.deploy-9f8e7d6c` in the composer's `@` menu
- a permission prompt whose body is generic (`Call tool skill`); its **Always allow** option
  lists the saved `nested.` ID

Detail and the full limit list: [docs/limits.md](docs/limits.md).

## Limits

| Limit | Value |
|---|---|
| Subproject depth | 5 directories below the workspace; unbounded inside an opened skill root |
| Scan budgets | 20,000 directories · 5,000 skill files · 128 KiB per file · 16 MiB total |
| Display caps | name 80 code points · description 500 |
| `autoinvoke: false` | hidden from the model's guidance block, still user-invocable |
| Composer and prompt | `@<id>` in the menu; `Call tool skill` on approval, ID in **Always allow** |
| Scale | around 50 nested entries is the point to revisit on-demand listing |

A truncated scan still advertises what it found. No limit is configurable in this release.

## Permissions

A `skill` rule is matched against the **ID**, not the display name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "skill": {
      "*": "ask",
      "nested.*": "allow"
    }
  }
}
```

Rules are evaluated from the end, so the last matching rule wins and the catch-all belongs
first. A rule written with a display name (`vscode/deploy`) matches nothing at all.
`deny` also removes the entry from the model's guidance block. Allow, deny-one-subproject,
and exact-ID examples: [docs/permissions.md](docs/permissions.md).

## Troubleshooting

- **An expected skill is missing.** Check the subproject has one of the eight markers
  (`.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`, `AGENTS.md`,
  `CLAUDE.md`, `.git`, `.hg`), that it sits at most 5 directories below the workspace, and
  that no directory in the path is pruned (`node_modules`, `dist`, `vendor`, …). Only
  `*.md` directly under a skill root and `SKILL.md` below it count.
- **A skill never appears even though it exists on disk.** A `skill` rule that denies its
  ID removes it from the guidance block, so the model never sees it.
- **You need to see what was discovered.** Read storage: `nested/manifest/version`,
  `nested/manifest/<scopeToken>` (ids and names), `nested/subproject/<scopeToken>` (with
  content). Raw KV keys carry the host's `plugin:<id>:` prefix, so filter
  `LIKE 'plugin:%:nested/%'`. A record only disappears when the same location refreshes
  again after the skill is gone.
- **A refresh looks delayed.** Events are coalesced for 250 ms, and a prompt-triggered
  refresh runs at most once per 2 s. Diagnostics are attached to the `RefreshOutcome` that
  `activate()`/`refresh()` return, but no opencode `v2.0.26` surface renders them — see
  [docs/architecture.md](docs/architecture.md#failure-model).

## Development

```sh
npm ci
npm run typecheck
npm test
```

`tsc --noEmit` plus the `vitest` suite is the whole gate; no linter is configured
(`package.json:7-11`).

## Documentation

- [Architecture](docs/architecture.md) — pipeline, identity, storage, refresh, failure model
- [Installation](docs/installation.md) — loading, verifying, uninstalling
- [Limits](docs/limits.md) — depth, budgets, caps, surfaces
- [Permissions](docs/permissions.md) — correct `nested.*` rules

## Design

- Solution: `/Users/ganggang/work/my-work/spikes/opencode-nested-context-plugin/solution.md`
- Decisions: `/Users/ganggang/work/my-work/spikes/opencode-nested-context-plugin/adrs/`

Both paths point outside this repository, into the workspace where the design was written.
