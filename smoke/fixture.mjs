import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

export const DEPLOY_A = "---\nname: deploy\ndescription: Deploys pkg-a\n---\n# Deploy\n\nDeploys pkg-a.\n"
export const FOO_A = "---\nname: foo\ndescription: Foocraft\n---\n# Foo\n\nFoocraft.\n"
export const DEPLOY_B = "---\nname: deploy\ndescription: Deploys pkg-b\n---\n# Deploy\n\nDeploys pkg-b.\n"
export const TIDY_C =
  "---\nname: tidy\ndescription: 'Deploy \"safe\" & <fast>'\ndisable-model-invocation: true\n---\n# Tidy\n\nTidy up.\n"
export const LINT_D = "---\nname: lint\n---\n# Lint\n\nLints deeply.\n"
export const NATIVE_ROOT = "---\nname: native-root\n---\n# Native root\n"
export const GLOBAL_DEMO = "---\nname: global-demo\n---\n# Global demo\n"

const LOCATION_CONFIG = `${JSON.stringify({ skills: ["./pkg-a/.opencode/skills"] }, null, 2)}\n`

export const MATRIX = [
  { path: ".opencode/skills/native-root/SKILL.md", content: NATIVE_ROOT },
  { path: "opencode.json", content: LOCATION_CONFIG },
  { path: "pkg-a/.opencode/skills/deploy/SKILL.md", content: DEPLOY_A },
  { path: "pkg-a/.opencode/skills/foo.md", content: FOO_A },
  { path: "pkg-b/.claude/skills/deploy/SKILL.md", content: DEPLOY_B },
  { path: "pkg-c/.agents/skills/tidy/SKILL.md", content: TIDY_C },
  { path: "pkg-d/AGENTS.md", content: "# pkg-d\n" },
  { path: "pkg-d/deep/nest/.opencode/skill/lint/SKILL.md", content: LINT_D },
]

export const GLOBAL_MATRIX = [{ path: "skills/global-demo/SKILL.md", content: GLOBAL_DEMO }]

function write(root, entry) {
  const target = join(root, entry.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, entry.content)
  return target
}

export function buildFixture(options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "f8-smoke-ws-"))
  const real = join(root, "real")
  const alias = join(root, "alias")
  const config = join(root, "config")

  mkdirSync(real, { recursive: true })
  mkdirSync(config, { recursive: true })
  for (const entry of MATRIX) write(real, entry)
  for (const entry of GLOBAL_MATRIX) write(config, entry)
  symlinkSync(real, alias, "dir")

  return { root, real, alias, config, entries: MATRIX.length, globalEntries: GLOBAL_MATRIX.length }
}

export function buildIsolation(fixture) {
  const home = join(fixture.root, "home")
  mkdirSync(home, { recursive: true })

  return {
    home,
    env: {
      ...process.env,
      OPENCODE_TEST_HOME: home,
      OPENCODE_CONFIG_DIR: fixture.config,
    },
  }
}

export function installPlugin(fixture, repo) {
  const plugins = join(fixture.real, ".opencode/plugins")
  mkdirSync(plugins, { recursive: true })
  const target = join(plugins, "nested-skill-discovery")
  symlinkSync(repo, target, "dir")
  return target
}

export function removePlugin(fixture) {
  const target = join(fixture.real, ".opencode/plugins/nested-skill-discovery")
  if (!existsSync(target)) return false
  rmSync(target, { force: true })
  return true
}

export function listTree(root) {
  const lines = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(directory, entry.name)
      const rel = relative(root, absolute)
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) {
        lines.push(`link ${rel} -> ${readlinkSync(absolute)}`)
        continue
      }
      lines.push(`${info.isDirectory() ? "dir " : "file"} ${rel}`)
      if (info.isDirectory()) walk(absolute)
    }
  }
  walk(root)
  return lines
}

export function removeTree(path) {
  rmSync(path, { recursive: true, force: true })
  return !existsSync(path)
}
