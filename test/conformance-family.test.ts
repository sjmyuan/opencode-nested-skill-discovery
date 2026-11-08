import { realpath, rm } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { locationTokenFor, scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import { createRegistry } from "../src/registry.ts"
import { scanSkills } from "../src/scan.ts"
import { deriveWatchTargets } from "../src/watch.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { checkoutSkill, createFamilyWorkspace, type FamilyWorkspace } from "./support/family-fixtures.ts"

const MAIN = ["effect", "opencode-dev", "rtl-aware-development", "sample-skill", "agent", "browser", "commit", "review"]
const WORKTREE = ["effect", "opencode-dev", "rtl-aware-development", "sample-skill"]
const AGENT_SKILLS = ["git-helper", "test-skill"]
const COPILOT = ["launch", "sample", "tidy"]
const WORKTREE_DIR = "opencode-v2.0.26"

const workspaces: FamilyWorkspace[] = []

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const buildWorkspace = async (): Promise<FamilyWorkspace> => {
  const ws = await createFamilyWorkspace()
  workspaces.push(ws)
  await ws.repo("opencode")
  await ws.worktree(WORKTREE_DIR, "opencode", WORKTREE_DIR)
  for (const slug of MAIN) await checkoutSkill(ws, "opencode", slug)
  for (const slug of WORKTREE) await checkoutSkill(ws, WORKTREE_DIR, slug)
  await ws.repo("opencode-agent-skills")
  for (const slug of AGENT_SKILLS) await checkoutSkill(ws, "opencode-agent-skills", slug)
  await ws.repo("vscode")
  await checkoutSkill(ws, "vscode", "launch")
  for (const slug of COPILOT) await checkoutSkill(ws, "vscode/extensions/copilot", slug)
  return ws
}

const worktreeToken = async (ws: FamilyWorkspace): Promise<string> =>
  scopeTokenFor(await realpath(path.join(ws.root, WORKTREE_DIR)))

const idsOf = (entries: ReadonlyArray<{ readonly id: unknown }>): readonly string[] =>
  entries.map((entry) => String(entry.id))

const namesOf = (entries: ReadonlyArray<{ readonly name: unknown }>): readonly string[] =>
  entries.map((entry) => String(entry.name))

describe("conformance: one checkout view per repo family", () => {
  it("C1: the family advertises 8 survivor entries, 0 worktree entries, and no duplicate name", async () => {
    const ws = await buildWorkspace()
    const fake = fakeContext([], { directory: ws.root })

    const outcome = await createRegistry(fake.ctx).activate()
    const entries = fake.editor.list()
    const names = namesOf(entries)

    expect(outcome.ok).toBe(true)
    expect(outcome.skills).toBe(14)
    expect(outcome.subprojects).toBe(4)
    expect(entries).toHaveLength(14)
    expect(names.filter((name) => name.startsWith("opencode/")).sort()).toEqual(
      MAIN.map((slug) => `opencode/${slug}`).sort(),
    )
    expect(names.filter((name) => name.startsWith(`${WORKTREE_DIR}/`))).toEqual([])
    expect(names.filter((name) => name.startsWith("opencode-agent-skills/"))).toHaveLength(2)
    expect(names.filter((name) => name === "vscode/launch")).toHaveLength(1)
    expect(names.filter((name) => name === "vscode/extensions/copilot/launch")).toHaveLength(1)
    expect(new Set(names).size).toBe(names.length)
  })

  it("C2: no suppressed id reaches the registry", async () => {
    const ws = await buildWorkspace()
    const fake = fakeContext([], { directory: ws.root })

    await createRegistry(fake.ctx).activate()
    const ids = idsOf(fake.editor.list())
    const token = await worktreeToken(ws)
    const effectToken = skillTokenFor(
      "effect",
      await realpath(path.join(ws.root, WORKTREE_DIR, ".opencode/skills/effect/SKILL.md")),
    )

    expect(ids.some((id) => id.startsWith(`nested.${token}.`))).toBe(false)
    expect(ids).not.toContain(`nested.${token}.${effectToken}`)
  })

  it("C3: no manifest or cache record survives, and a stale one is pruned", async () => {
    const ws = await buildWorkspace()
    const token = await worktreeToken(ws)
    const directory = await realpath(path.join(ws.root, WORKTREE_DIR))
    const locationToken = locationTokenFor(await realpath(ws.root))
    const fake = fakeContext([], {
      directory: ws.root,
      storage: [
        [
          `nested/${locationToken}/manifest/${token}`,
          { manifestVersion: 1, scopeToken: token, directory, entries: [] },
        ],
        [`nested/${locationToken}/subproject/${token}`, { scopeToken: token, directory, skills: [] }],
      ],
    })

    await createRegistry(fake.ctx).activate()

    expect(fake.storage.has(`nested/${locationToken}/manifest/${token}`)).toBe(false)
    expect(fake.storage.has(`nested/${locationToken}/subproject/${token}`)).toBe(false)
  })

  it("C4: suppression needs exactly one reload", async () => {
    const ws = await buildWorkspace()
    const fake = fakeContext([], { directory: ws.root })

    const outcome = await createRegistry(fake.ctx).activate()

    expect(outcome.reloads).toBe(1)
    expect(fake.reloadCalls).toBe(1)
  })

  it("C5: the watch set is identical with and without the worktree .git", async () => {
    const ws = await buildWorkspace()
    const withGit = await scanSkills({ location: ws.root })
    const targetsWith = await deriveWatchTargets({ location: ws.root, candidates: withGit.candidates })

    await rm(path.join(ws.root, WORKTREE_DIR, ".git"))
    const withoutGit = await scanSkills({ location: ws.root })
    const targetsWithout = await deriveWatchTargets({ location: ws.root, candidates: withoutGit.candidates })

    expect(withGit.candidates.length).toBeGreaterThan(0)
    expect(targetsWithout.targets).toEqual(targetsWith.targets)
  })

  it("C6: a rescan flips suppression both ways", async () => {
    const ws = await buildWorkspace()
    const fake = fakeContext([], { directory: ws.root })
    const registry = createRegistry(fake.ctx)

    const first = await registry.activate()
    await rm(path.join(ws.root, "opencode", ".git"), { recursive: true })
    const second = await registry.refresh()
    await ws.mkdirp(`opencode/.git/worktrees/${WORKTREE_DIR}`)
    const third = await registry.refresh()

    expect(first.skills).toBe(14)
    expect(second.skills).toBe(18)
    expect(third.skills).toBe(14)
  })

  it("C7: a session located at the worktree still advertises its own view", async () => {
    const ws = await buildWorkspace()
    const location = await realpath(path.join(ws.root, WORKTREE_DIR))
    const natives = WORKTREE.map((slug) =>
      nativeSkill(slug, path.join(location, ".opencode/skills", slug, "SKILL.md")),
    )
    const fake = fakeContext(natives, { directory: location })

    const outcome = await createRegistry(fake.ctx).activate()
    const entries = fake.editor.list()

    expect(outcome.skills).toBe(0)
    expect(entries).toHaveLength(WORKTREE.length)
    expect([...idsOf(entries)].sort()).toEqual([...WORKTREE].sort())
    expect(idsOf(entries).some((id) => id.startsWith("nested."))).toBe(false)
    expect(namesOf(entries).some((name) => name.startsWith("opencode/"))).toBe(false)
  })

  it("C8: distinct subprojects of one repo never collapse", async () => {
    const ws = await buildWorkspace()
    const fake = fakeContext([], { directory: ws.root })

    const outcome = await createRegistry(fake.ctx).activate()
    const names = namesOf(fake.editor.list())

    expect(outcome.subprojects).toBe(4)
    expect(names).toContain("vscode/launch")
    expect(names).toContain("vscode/extensions/copilot/launch")
    expect(names).toContain("opencode/effect")
  })

  it("C9: one transform registers the nested view and leaves natives byte-identical", async () => {
    const ws = await buildWorkspace()
    const native = nativeSkill("global-review", "/tmp/native-skills/global-review/SKILL.md")
    const fake = fakeContext([native], { directory: ws.root })

    await createRegistry(fake.ctx).activate()
    const entries = fake.editor.list()
    const kept = entries.find((entry) => String(entry.id) === "global-review")

    expect(fake.transforms).toHaveLength(1)
    expect(kept).toEqual(native)
    expect(entries).toHaveLength(15)
  })
})
