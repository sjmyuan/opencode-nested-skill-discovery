# Installation

The plugin is a local opencode plugin. It is not published to npm (`package.json:4`), so
there is nothing to `npm install` in order to *load* it — you point opencode at this
directory.

## Requirements

| Requirement | Detail |
|---|---|
| opencode `v2.2.5` | the runtime this release targets; `@opencode/plugin` is a `2.2.5` devDependency for compile-time types and the `Plugin.define` value (`index.ts:1`, `package.json:16-21`) |
| Bun | opencode hosts plugins on Bun; the module resolution quoted below is Bun's (`packages/util/src/runtime/import.bun.ts:7-10`) |
| Node `v25.2.1` + npm | only for the development toolchain (`tsc`, `vitest`); not needed to run the plugin |

Only the repository directory is required at runtime. Its `node_modules` is **not** loaded:
opencode supplies `@opencode/plugin` and `effect` itself
(`packages/plugin/src/runtime-modules.ts:7`), and a plugin that resolves its own copy is
refused with an explicit error (`packages/plugin/src/runtime.ts:28-35`). The package declares
`effect` only so its type import resolves to the version the host supplies; it must never
resolve its own copy at runtime.

## Where opencode looks

Automatic discovery scans both `plugin` and `plugins` inside every config directory
opencode loads — each project `.opencode` root and the global config directory
(`packages/core/src/plugin/source-directory.ts:7`, consumed by
`packages/core/src/config/plugin/source.ts:128-136`; roots from
`packages/core/src/config/discovery.ts:25-70`).

An entry can be:

- a file ending in `.ts` or `.js`
- a directory — resolved as `<dir>/index`
- a symlink to either of the above (`packages/core/src/plugin/source-directory.ts:21-31`)

A directory target is resolved by trying `<dir>/server` and then `<dir>/index`
(`packages/plugin/src/host.ts:17-44`). This repository's entry is `index.ts`, which
default-exports the plugin definition (`index.ts:1-4`), and no `package.json` field is
consulted for that resolution.

## Install

Symlink (recommended — edit the checkout, reload opencode):

```sh
mkdir -p <workspace>/.opencode/plugins
ln -s <path-to-this-checkout> \
      <workspace>/.opencode/plugins/nested-skill-discovery
```

Copy (independent snapshot of the code):

```sh
mkdir -p <workspace>/.opencode/plugins
cp -R <path-to-this-checkout> \
      <workspace>/.opencode/plugins/nested-skill-discovery
```

Either form works because discovery accepts a symlink that resolves to a directory
(`packages/core/src/plugin/source-directory.ts:26-29`). Use `~/.config/opencode/plugins/`
instead of a workspace path to load it in every project.

You can also name the directory explicitly in `opencode.json`, relative to that config file
or as an absolute path (`packages/core/src/config/plugin/source.ts:139-155`):

```json
{ "plugin": ["./.opencode/plugins/nested-skill-discovery"] }
```

A configured target must be a directory; a path that points at a single file is rejected
with `configured plugin path must be a directory`
(`packages/core/src/config/plugin/source.ts:149-153`).

## Verify it loaded

1. **The model's guidance block** lists one `<skill>` per advertised entry, with `<id>`,
   `<name>`, and `<description>` (`packages/core/src/skill/instructions.ts:16-22`). Entries
   appear as `nested.<scope>.<skill>`; ids are listed in
   [permissions.md](permissions.md#finding-the-ids).
2. **The `@` menu** in the composer shows `@<id>`, for example
   `@nested.vscode-1a2b3c4d.deploy-9f8e7d6c`
   (`packages/tui/src/component/prompt/autocomplete.tsx:429-431`).
3. **Storage** gains `nested/<locationToken>/manifest/version`,
   `nested/<locationToken>/manifest/<scopeToken>`, and
   `nested/<locationToken>/subproject/<scopeToken>` — see
   [architecture.md](architecture.md#storage-model) for the raw-key namespace.
4. **Commands** appear as `subproject:command`: the composer's `ctrl+p commands` list and
   `GET /api/command` both show one entry per published nested command, and a name that
   collides with a native command is absent (`src/command-shadow.ts:28-53`).

If nothing appears, work through [limits.md](limits.md) first: confirm the subproject carries
a marker, that it is within the depth bound, and that no directory in the path is pruned.
Only a skill root that the plugin never discovered can be missing for those reasons; a
discovered entry that is denied by a permission rule is absent from the guidance block for a
different reason ([permissions.md](permissions.md)).

## Upgrading

Re-pull the checkout for a symlink install, or replace the copied directory. Restart
opencode, or move the workspace, so the plugin is activated again; a running instance keeps
the code it loaded.

## Uninstall

Remove the symlink or the copied directory and, if you added one, the `opencode.json`
entry. The plugin owns no state outside storage: its `nested/*` records stay behind until a
later refresh **of that same location** prunes the tokens that are no longer active
(`src/manifest.ts:79-117`, `201-208`). Records belonging to another location are never
removed, and no record is read back as an advertisement input. Records are keyed by the
location's canonical path, so a workspace you move or rename keeps its old records until a
refresh of the old location prunes them.

## Development

```sh
npm ci
npm run typecheck
npm test
```

`npm ci` installs from `package-lock.json`; the gate is `tsc --noEmit` plus `vitest run`
(`package.json:7-12`). The entry point stays `index.ts`.
