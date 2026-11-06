# opencode-nested-skill-discovery

An OpenCode plugin that will discover skills in nested subprojects of a workspace and advertise them as `nested.`-prefixed entries alongside the native ones. Native discovery stays untouched: the plugin only appends entries through the skill transform it registers.

## Status

Scaffold (F1) — no nested skill is registered yet. The plugin loads, registers one no-op `skill.transform`, and replays an empty frozen snapshot, so the skill registry is byte-for-byte identical with and without it.

## How it is loaded

A local directory plugin, not published to npm. Symlink or copy this repository into a workspace plugin directory:

```
mkdir -p <workspace>/.opencode/plugins
ln -s /Users/ganggang/work/opencode-nested-skill-discovery <workspace>/.opencode/plugins/nested-skill-discovery
```

OpenCode resolves the entrypoint as `<dir>/index.ts`; the module default-exports `Plugin.define({ id: "nested-skill-discovery", setup })`. The host provides `@opencode/plugin` at runtime, so the dependency here is a devDependency for types only.

## Development

Requires Node (dev toolchain is `tsc` + `vitest`; the plugin itself runs under Bun inside OpenCode).

```
npm install
npm run typecheck
npm test
```

## Design

- Solution: `/Users/ganggang/work/my-work/spikes/opencode-nested-context-plugin/solution.md`
- Decisions: `/Users/ganggang/work/my-work/spikes/opencode-nested-context-plugin/adrs/`
