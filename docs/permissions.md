# Permissions

A `skill` permission rule is matched against the skill **ID**, never its display name. An
ID-keyed rule is the only kind that works; a name-keyed rule matches nothing and silently
falls through to the next rule.

The rule target is the ID because both places that consult the `skill` ruleset pass the ID:
the guidance-block filter calls `Permission.evaluate("skill", skill.id, …)`
(`packages/core/src/skill.ts:33-34`) and the skill tool asserts
`action: "skill"`, `resources: [skill.id]` (`packages/core/src/tool/plugin/skill.ts:51-58`).
The opencode docs page still says `skill` "matches the skill name"
(`packages/web/src/content/docs/permissions.mdx:162`); at `v2.0.26` that sentence does not
match the code, so ignore it and key on IDs. No upstream issue has been filed for the
discrepancy.

## Rule shape

`permission.skill` takes either one effect for every skill, or an object of
`pattern → "allow" | "ask" | "deny"`:

```json
{ "permission": { "skill": "ask" } }
```

```json
{ "permission": { "skill": { "nested.*": "allow" } } }
```

- **Last matching rule wins.** Evaluation walks the flattened ruleset from the end and
  stops at the first rule whose action and resource patterns both match
  (`packages/core/src/permission.ts:87-95`). Object entries are flattened in declaration
  order (`packages/core/src/config/normalize.ts:510-525`), so put the catch-all first and
  the exception last.
- **Patterns are anchored full matches.** `*` matches any run of characters, including
  `.`; `?` matches exactly one character
  (`packages/core/src/util/wildcard.ts:3-14`). `nested.*` therefore also matches
  `nested.a-0000aaaa.b-1111bbbb`, and `nested?x` matches `nested.x`.
- **No matching rule falls back to `"ask"`** (`packages/core/src/permission.ts:91-95`). In
  practice the default agent already carries `{ "action": "*", "resource": "*", "effect":
  "allow" }` first, so out of the box skill loading is allowed
  (`packages/schema/src/agent.ts:45-51`); rules you add come after it and win.

## Examples

Allow every nested entry, deny one subproject. Everything else, including native skills,
still asks:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "skill": {
      "*": "ask",
      "nested.*": "allow",
      "nested.vscode-1a2b3c4d.*": "deny"
    }
  }
}
```

Deny every nested entry, allow one subproject. Native skills stay allowed:

```json
{
  "permission": {
    "skill": {
      "*": "allow",
      "nested.*": "deny",
      "nested.vscode-1a2b3c4d.*": "allow"
    }
  }
}
```

Pin and block individual entries by exact ID:

```json
{
  "permission": {
    "skill": {
      "nested.vscode-1a2b3c4d.deploy-9f8e7d6c": "allow",
      "nested.vscode-1a2b3c4d.dangerous-0b1c2d3e": "deny"
    }
  }
}
```

The scope part is the subproject slug plus 8 hex characters, the skill part is the skill
slug plus 8 hex characters, so an ID contains only `nested.`, two lower-case `[a-z0-9-]`
slugs, a hyphen, and hex — never `*` or `?`
([architecture.md](architecture.md#identity)). A copied ID always matches literally, and
`nested.*` is the only wildcard you need.

Two forms that look right and match nothing:

| Rule | Why it never matches |
|---|---|
| `"vscode/deploy"`, `"vscode/deploy: ask"` | the resource is the ID, `nested.<scope>.<skill>` |
| `"…/vscode/deploy"` (the truncated display name) | display names are never a resource |

IDs are path-derived: renaming or moving a subproject changes its scope token, and every
exact-ID rule below it stops matching
([architecture.md](architecture.md#identity)). Prefer `nested.<scope>.*` over exact IDs
unless you want a rule to break on a move.

## What each effect does

| Effect | Result |
|---|---|
| `deny` | the entry is removed from the model's guidance block before the model ever sees it, and a direct load fails |
| `ask` | the model can see the entry; loading it raises a prompt whose body is generic and whose **Always allow** option shows the ID |
| `allow` | the model can see the entry and loads it without a prompt |

`deny` is applied when the guidance block is built: the block is
`Skill.available(...)`, which filters out every skill whose evaluated effect is `deny`
(`packages/core/src/skill/instructions.ts:74-81`, `packages/core/src/skill.ts:33-34`). A
denied nested entry therefore disappears from `<available_skills>` while the rest of the
plugin's entries stay listed. A direct reference to it still goes through the tool, which
asserts the same rule and fails with `Unable to load skill …`
(`packages/core/src/tool/plugin/skill.ts:46-60`).

The prompt body is the same for every skill: title `Call tool skill`, line `Tool: skill`
(`packages/tui/src/util/permission.ts:139-143`). The identity appears on the **Always
allow** option: choosing it swaps the body for the patterns the click will save
(`permissionAlwaysLines`, `packages/tui/src/util/permission.ts:154-160`; rendered at
`packages/tui/src/routes/session/permission.tsx:223-231`). The skill tool asks to save
exactly its ID (`save: [skill.id]`, `packages/core/src/tool/plugin/skill.ts:51-58`), so
those lines read `- nested.<scope>.<skill>`. Read them before approving: that is the only
place the prompt names the entry.

Choosing **Always allow** saves an `allow` rule for exactly this ID
(`packages/core/src/permission.ts:299-305`). A configured `deny` is evaluated first and is
never overridden by a saved allow: the deny pass runs over the configured rulesets before
saved rules are appended (`packages/core/src/permission.ts:165-176`). A saved allow does
upgrade a configured `ask`.

## Finding the IDs

| Surface | What it shows |
|---|---|
| the model's guidance block | `<id>`, `<name>`, `<description>` per entry (`packages/core/src/skill/instructions.ts:16-22`) |
| the composer's `@` menu | `@<id>` (`packages/tui/src/component/prompt/autocomplete.tsx:429-431`) |
| storage | `nested/manifest/<scopeToken>` holds `entries[].id` for that subproject (`src/manifest.ts:138-143`) |

The records live in opencode's SQLite database `opencode.db`, in the global data directory —
`~/.local/share/opencode/opencode.db`, or `$XDG_DATA_HOME/opencode/opencode.db`, with
`OPENCODE_DB` overriding the file and a channel suffix on non-release builds
(`packages/cli/src/database-path.ts:4-13`, `packages/util/src/global-roots.ts:5-13`). They are
namespaced by the host (`packages/core/src/plugin/host.ts:609-616`), so filter on the plugin
prefix:

```sh
sqlite3 ~/.local/share/opencode/opencode.db \
  "select key from kv where key like 'plugin:%:nested/manifest/%';"
```

Everything after `plugin:<hex of the plugin id>:` is the logical key, so the listed rows read
`nested/manifest/<scopeToken>`.

## Per-agent rules

The native form is a `permissions` array of `{ action, resource, effect }` rules at the top
level, and the same array under `agents.<id>` (`packages/schema/src/config.ts:54-59`,
`packages/schema/src/config/agent.ts:21`). Global rules are appended to every agent first and
that agent's own rules after (`packages/core/src/config/plugin/agent.ts:90-92`, `121-123`),
so with last-match-wins the agent's rules override the global ones:

```json
{
  "permissions": [
    { "action": "skill", "resource": "nested.*", "effect": "allow" }
  ],
  "agents": {
    "review": {
      "permissions": [
        { "action": "skill", "resource": "nested.*", "effect": "ask" }
      ]
    }
  }
}
```

The v1 `agent.<id>.permission` object form still works because the config normaliser migrates
it into `agents` (`packages/core/src/config/normalize.ts:134`, `155-164`); prefer the native
form above for new configuration.

Session-level rules, where a host or another plugin sets them, merge after the agent's and
therefore win over both (`packages/core/src/permission.ts:158-164`,
`packages/core/src/session/context.ts:130-131`).
