import { createHash } from "node:crypto"
import { realpath, rm } from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { ID_PREFIX, MAX_ID_LENGTH } from "../src/contracts.ts"
import { indexCandidates } from "../src/indexer.ts"
import { createWorkspace, doc, only, type Workspace } from "./support/indexer-fixtures.ts"

const workspaces: Workspace[] = []

const workspace = async (): Promise<Workspace> => {
  const created = await createWorkspace()
  workspaces.push(created)
  return created
}

afterAll(async () => {
  await Promise.all(workspaces.map((entry) => entry.cleanup()))
})

const hex8 = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8)

const slugOf = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x"

describe("indexed entries", () => {
  it("builds the entry with a path-derived id and the body as content", async () => {
    const ws = await workspace()
    const body = "# Deploy\n\nDeploys releases.\n"
    await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy\ndescription: Deploys releases", body))
    const candidate = await ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a")
    const subprojectRealPath = await realpath(path.join(ws.root, "a"))

    const result = await indexCandidates([candidate], { location: ws.root })
    const entry = only(result.skills)

    expect(result.diagnostics).toEqual([])
    expect(entry.id).toBe(
      `${ID_PREFIX}${slugOf(path.basename(subprojectRealPath))}-${hex8(subprojectRealPath)}.deploy-${hex8(candidate.realPath)}`,
    )
    expect(entry.id).toMatch(/^nested\.[a-z0-9-]+\.[a-z0-9-]+$/)
    expect(entry.id.length).toBeLessThanOrEqual(MAX_ID_LENGTH)
    expect(entry.canonicalPath).toBe(candidate.realPath)
    expect(entry.subproject).toBe("a")
    expect(entry.nativeName).toBe("deploy")
    expect(entry.description).toBe("Deploys releases")
    expect(entry.content).toBe(body)
    expect("autoinvoke" in entry).toBe(false)
  })

  it("keeps the frontmatter name raw and hashes only the path", async () => {
    const ws = await workspace()
    const file = await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: Deploy Release\ndescription: Deploys"))
    const candidate = await ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a")

    const result = await indexCandidates([candidate], { location: ws.root })
    const entry = only(result.skills)

    expect(entry.nativeName).toBe("Deploy Release")
    expect(entry.id.endsWith(`.deploy-${hex8(file)}`)).toBe(true)
    expect(entry.id).not.toContain("deploy-release")
  })

  it("synthesizes the description from the first text line, else the skill name", async () => {
    const ws = await workspace()
    await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy", "# Title\n\n  Real description here.  \n"))
    await ws.write("a/.opencode/skills/notes/SKILL.md", doc("name: notes", "# Only a heading\n\n"))
    await ws.write("a/.opencode/skills/plain/SKILL.md", "# Plain\n\nNo frontmatter at all.\n")

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a"),
        ws.candidate("a/.opencode/skills/notes/SKILL.md", "a"),
        ws.candidate("a/.opencode/skills/plain/SKILL.md", "a"),
      ]),
      { location: ws.root },
    )

    const byName = new Map(result.skills.map((entry) => [entry.nativeName, entry]))
    expect(byName.get("deploy")?.description).toBe("Real description here.")
    expect(byName.get("notes")?.description).toBe("skill notes")
    expect(byName.get("plain")?.description).toBe("No frontmatter at all.")
  })

  it("carries autoinvoke from metadata and disable-model-invocation", async () => {
    const ws = await workspace()
    await ws.write("a/.opencode/skills/on/SKILL.md", doc("name: on\nmetadata:\n  opencode/autoinvoke: true"))
    await ws.write("a/.opencode/skills/off/SKILL.md", doc("name: off\ndisable-model-invocation: true"))
    await ws.write("a/.opencode/skills/idle/SKILL.md", doc("name: idle"))

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.opencode/skills/on/SKILL.md", "a"),
        ws.candidate("a/.opencode/skills/off/SKILL.md", "a"),
        ws.candidate("a/.opencode/skills/idle/SKILL.md", "a"),
      ]),
      { location: ws.root },
    )

    const byName = new Map(result.skills.map((entry) => [entry.nativeName, entry]))
    expect(byName.get("on")?.autoinvoke).toBe(true)
    expect(byName.get("off")?.autoinvoke).toBe(false)
    expect("autoinvoke" in (byName.get("idle") ?? {})).toBe(false)
  })

  it("derives the scope token from the location when the subproject is empty", async () => {
    const ws = await workspace()
    await ws.write(".agents/skills/deploy/SKILL.md", doc("name: deploy"))
    const candidate = await ws.candidate(".agents/skills/deploy/SKILL.md")

    const result = await indexCandidates([candidate], { location: ws.root })

    expect(only(result.skills).id.startsWith(`${ID_PREFIX}${slugOf(path.basename(ws.root))}-`)).toBe(true)
  })
})

describe("dedupe", () => {
  it("collapses the same native skill from skills and skill, keeping skills", async () => {
    const ws = await workspace()
    const kept = await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy", "# Deploy\n\nfrom skills.\n"))
    const loser = await ws.write("a/.opencode/skill/deploy/SKILL.md", doc("name: deploy", "# Deploy\n\nfrom skill.\n"))

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a"),
        ws.candidate("a/.opencode/skill/deploy/SKILL.md", "a"),
      ]),
      { location: ws.root },
    )

    expect(only(result.skills).content).toContain("from skills.")
    expect(result.diagnostics).toEqual([`duplicate: ${loser} (kept ${kept})`])
  })

  it("prefers the deeper config root", async () => {
    const ws = await workspace()
    const loser = await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy", "# Deploy\n\nshallow.\n"))
    const kept = await ws.write("a/x/.opencode/skills/deploy/SKILL.md", doc("name: deploy", "# Deploy\n\ndeep.\n"))

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a"),
        ws.candidate("a/x/.opencode/skills/deploy/SKILL.md", "a"),
      ]),
      { location: ws.root },
    )

    expect(only(result.skills).content).toContain("deep.")
    expect(result.diagnostics).toEqual([`duplicate: ${loser} (kept ${kept})`])
  })

  it("prefers agents roots over claude roots", async () => {
    const ws = await workspace()
    const kept = await ws.write("a/.agents/skills/deploy/SKILL.md", doc("name: deploy", "# Deploy\n\nagents.\n"))
    const loser = await ws.write("a/.claude/skills/deploy/SKILL.md", doc("name: deploy", "# Deploy\n\nclaude.\n"))

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.claude/skills/deploy/SKILL.md", "a"),
        ws.candidate("a/.agents/skills/deploy/SKILL.md", "a"),
      ]),
      { location: ws.root },
    )

    expect(only(result.skills).content).toContain("agents.")
    expect(result.diagnostics).toEqual([`duplicate: ${loser} (kept ${kept})`])
  })

  it("collapses two paths that share one realpath and hashes the realpath", async () => {
    const ws = await workspace()
    const real = await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy"))
    const link = await ws.link("a/.claude/skills/deploy/SKILL.md", real)

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a"),
        ws.candidate("a/.claude/skills/deploy/SKILL.md", "a"),
      ]),
      { location: ws.root },
    )
    const entry = only(result.skills)

    expect(entry.canonicalPath).toBe(real)
    expect(entry.id.endsWith(`deploy-${hex8(real)}`)).toBe(true)
    expect(entry.id.endsWith(`deploy-${hex8(link)}`)).toBe(false)
    expect(result.diagnostics).toEqual([`duplicate: ${link} (kept ${real})`])
  })

  it("keeps the same skill in two subprojects", async () => {
    const ws = await workspace()
    await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy"))
    await ws.write("b/.opencode/skills/deploy/SKILL.md", doc("name: deploy"))

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a"),
        ws.candidate("b/.opencode/skills/deploy/SKILL.md", "b"),
      ]),
      { location: ws.root },
    )

    expect(result.skills).toHaveLength(2)
    expect(new Set(result.skills.map((entry) => entry.id)).size).toBe(2)
    expect(result.diagnostics).toEqual([])
  })
})

describe("skips and diagnostics", () => {
  it("skips a malformed file and still returns its siblings", async () => {
    const ws = await workspace()
    const broken = await ws.write("a/.opencode/skills/broken/SKILL.md", "---\nname: broken\ngreeting hello\n---\nbody\n")
    await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy"))

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("a/.opencode/skills/broken/SKILL.md", "a"),
        ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a"),
      ]),
      { location: ws.root },
    )

    expect(result.skills.map((entry) => entry.nativeName)).toEqual(["deploy"])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.startsWith(`malformed frontmatter: ${broken}: `)).toBe(true)
  })

  it("skips an unreadable file with a diagnostic instead of throwing", async () => {
    const ws = await workspace()
    const gone = await ws.write("a/.opencode/skills/gone/SKILL.md", doc("name: gone"))
    const candidate = await ws.candidate("a/.opencode/skills/gone/SKILL.md", "a")
    await rm(gone)

    const result = await indexCandidates([candidate], { location: ws.root })

    expect(result.skills).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.startsWith(`unreadable: ${candidate.realPath}: `)).toBe(true)
  })

  it("skips an unresolvable subproject with a diagnostic", async () => {
    const ws = await workspace()
    await ws.write("ghost/.opencode/skills/deploy/SKILL.md", doc("name: deploy"))
    const candidate = await ws.candidate("ghost/.opencode/skills/deploy/SKILL.md", "ghost")
    await rm(path.join(ws.root, "ghost"), { recursive: true, force: true })

    const result = await indexCandidates([candidate], { location: ws.root })

    expect(result.skills).toEqual([])
    expect(result.diagnostics[0]?.startsWith("unresolvable subproject: ")).toBe(true)
  })

  it("drops candidates inside a native root but not a sibling with the same prefix", async () => {
    const ws = await workspace()
    await ws.write("native/.agents/skills/x/SKILL.md", doc("name: x"))
    await ws.write("native-extra/.agents/skills/y/SKILL.md", doc("name: y"))

    const result = await indexCandidates(
      await Promise.all([
        ws.candidate("native/.agents/skills/x/SKILL.md"),
        ws.candidate("native-extra/.agents/skills/y/SKILL.md"),
      ]),
      { location: ws.root, nativeRoots: [path.join(ws.root, "native")] },
    )

    expect(result.skills.map((entry) => entry.nativeName)).toEqual(["y"])
    expect(result.diagnostics).toEqual([])
  })
})

describe("determinism", () => {
  it("returns the same sorted result whatever the scanner order", async () => {
    const ws = await workspace()
    await ws.write("a/.opencode/skills/deploy/SKILL.md", doc("name: deploy"))
    await ws.write("a/.opencode/skills/review.md", doc("name: review"))
    await ws.write("b/.agents/skills/audit/SKILL.md", doc("name: audit"))
    const candidates = await Promise.all([
      ws.candidate("a/.opencode/skills/deploy/SKILL.md", "a"),
      ws.candidate("a/.opencode/skills/review.md", "a"),
      ws.candidate("b/.agents/skills/audit/SKILL.md", "b"),
    ])

    const forward = await indexCandidates(candidates, { location: ws.root })
    const reversed = await indexCandidates([...candidates].reverse(), { location: ws.root })
    const ids = forward.skills.map((entry) => entry.id)

    expect(forward.skills).toEqual(reversed.skills)
    expect(forward.diagnostics).toEqual(reversed.diagnostics)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual([...ids].sort())
  })
})
