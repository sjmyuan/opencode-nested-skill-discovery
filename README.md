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
display names, add-only advertisement (the transform appends; a nested entry that duplicates
a native skill's path is suppressed), manifest/cache persistence, and refresh. Refresh
means a watcher set derived from the last good scan — every discovered skill and command
root — so an added, edited, or deleted command file republishes within one coalescing timer
at `DEBOUNCE_MS = 250` (`src/contracts.ts:137`), with a prompt backstop throttled to one
refresh per 2 s (`PROMPT_THROTTLE_MS`, `src/contracts.ts:140`); the implementation is
`src/watch.ts` and `src/backstop.ts`. The suite includes in-process conformance tests for the union,
projection, and dedupe claims (`test/conformance-*.test.ts`), and a live conformance harness
ships separately in `smoke/`: `npm run smoke:check` boots private `opencode serve` processes
and scores its claims C1–C8, reporting an unmet timing claim as `unproven` rather than green.

## Requirements

- opencode `v2.0.26` (`@opencode/plugin` is pinned to `2.0.26`, `package.json:14`)
- Bun, provided by opencode — the plugin runs inside the host
- Node `v25.2.1` + npm for the development toolchain only

The plugin is not published to npm (`package.json:4`) and needs no `npm install` to load.

## Install

Symlink this checkout into a workspace's plugin directory:

```sh
mkdir -p <workspace>/.opencode/plugins
ln -s <path-to-this-checkout> \
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

## Commands

A command file in a nested subproject — `.opencode/command/` or `.opencode/commands/` — is
published under its qualified name, `/subproject:command`; the `:` keeps the prefix in the
name a human types. `$1`–`$N` (the highest index absorbing the remaining arguments),
`$ARGUMENTS`, and `` !`cmd` `` shell interpolation expand in native's five steps (tokenise →
`$N` → `$ARGUMENTS` → append → shell interpolation, with one trim before the shell), and an
invocation routes the agent, the model, and a subagent child by the same rules native uses
(`src/command-execute.ts:30-104`, `src/command-expand.ts:56-150`). A composed name that
collides with a native command is dropped, never shadowed: a published name always carries its
`subproject:` qualifier, so a builtin (`init`, `review`) cannot collide, while an MCP prompt
named the same way is dropped before publication — including a prompt the host already held
when this plugin's transform registered (`src/command-shadow.ts:28-53`). A prompt that appears
after that activation is replaced silently until the next one; a command file that appears
later is reported by the audit and leaves the next snapshot. There is no `command` permission
action, so a published command needs no rule of its own.

## Limits

| Limit | Value |
|---|---|
| Subproject depth | 5 directories below the workspace; unbounded inside an opened skill root |
| Scan budgets | 20,000 directories · 5,000 skill and command files · 128 KiB per file · 16 MiB total |
| Skill display caps | name 80 code points · description 500; a command description is never capped |
| `autoinvoke: false` | hidden from the model's guidance block, still user-invocable |
| Composer and prompt | `@<id>` in the menu; `Call tool skill` on approval, ID in **Always allow** |
| Duplicate | a nested entry duplicating a native skill's path is suppressed on the refresh that sees it; when the foreign tier still looks incomplete, at the latest about 4 s after that refresh — otherwise on the next refresh |
| Worktree family | a linked worktree of the main checkout is hidden from an ancestor workspace, at the checkout root and in every nested subproject beneath it; only the main checkout's skills are advertised |
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

- **An expected skill is missing.** Check the subproject has one of the ten markers
  (`.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`,
  `.opencode/command`, `.opencode/commands`, `AGENTS.md`, `CLAUDE.md`, `.git`, `.hg`),
  that it sits at most 5 directories below the workspace, and
  that no directory in the path is pruned (`node_modules`, `dist`, `vendor`, …). Only
  `*.md` directly under a skill root and `SKILL.md` below it count.
- **A skill never appears even though it exists on disk.** A `skill` rule that denies its
  ID removes it from the guidance block, so the model never sees it.
- **A worktree's skill is missing from an ancestor session.** A linked worktree and its main
  checkout form one repo family, at the checkout root and in every nested subproject beneath
  it: an ancestor workspace advertises the main checkout's skills only, so a worktree copy
  such as `packages/app/.claude/skills` is hidden with a `family:` diagnostic. A nested
  subproject with no `.git` ancestor inside the workspace is a foreign checkout and stays
  visible, silently. Open the session inside the worktree to see its own view — see
  [docs/limits.md](docs/limits.md#worktree-families).
- **You need to see what was discovered.** Read storage: `nested/<locationToken>/manifest/version`,
  `nested/<locationToken>/manifest/<scopeToken>` (ids and names),
  `nested/<locationToken>/subproject/<scopeToken>` (with content). Commands have their own
  store: `nested/<locationToken>/commands/version`,
  `nested/<locationToken>/commands/manifest/<scopeToken>` (names, routing keys) and
  `nested/<locationToken>/commands/<scopeToken>` (with the template). Each location keys its
  own records, so one workspace never reads or prunes another's. Raw KV keys carry the host's
  `plugin:<id>:` prefix, so filter `LIKE 'plugin:%:nested/%'`. A record only disappears when
  the same location refreshes again after the skill or command is gone.
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
(`package.json:7-12`).

## Documentation

- [Architecture](docs/architecture.md) — pipeline, identity, storage, refresh, failure model
- [Installation](docs/installation.md) — loading, verifying, uninstalling
- [Limits](docs/limits.md) — depth, budgets, caps, surfaces
- [Permissions](docs/permissions.md) — correct `nested.*` rules
- [Design](docs/design.md) — the decisions of record and known divergences

## Design

The accepted decisions, the ADR titles, and where the design artefacts have drifted from the
shipped code are recorded in [docs/design.md](docs/design.md).
