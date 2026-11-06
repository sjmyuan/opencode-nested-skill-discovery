import { realpathSync, symlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { scopeTokenFor, skillTokenFor } from "../src/indexer.ts"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DEPLOY = "---\nname: deploy\ndescription: Deploys\n---\n# Deploy\n\nDeploys.\n"
const FOO = "---\nname: foo\ndescription: Foocraft\n---\n# Foo\n\nFoocraft.\n"
const TIDY = "---\nname: tidy\ndescription: Tidies\n---\n# Tidy\n\nTidies.\n"
const LINT = "---\nname: lint\ndescription: Lints\n---\n# Lint\n\nLints.\n"

async function nestedId(
  fixture: Awaited<ReturnType<typeof createRegistryFixture>>,
  subproject: string,
  nativeId: string,
  file: string,
): Promise<string> {
  return `nested.${scopeTokenFor(await fixture.realpathOf(subproject))}.${skillTokenFor(
    nativeId,
    await fixture.realpathOf(file),
  )}`
}

describe("conformance: symlinked location dedupe", () => {
  // F5-r1 (679dd56) canonicalises foreign paths; the pre-fix failure is recorded in evidence/dedupe-red-prefix.txt.
  it("registers a symlinked location's native twins exactly once", async () => {
    const fixture = await createRegistryFixture()
    const alias = `${fixture.root}-alias`
    symlinkSync(fixture.root, alias, "dir")

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DEPLOY)
      await fixture.write("A/.opencode/skills/foo.md", FOO)
      await fixture.write("B/.claude/skills/deploy/SKILL.md", DEPLOY)
      await fixture.write("C/.agents/skills/tidy/SKILL.md", TIDY)
      await fixture.write("D/deep/nest/.opencode/skill/lint/SKILL.md", LINT)
      await fixture.write(".opencode/skills/native-root/SKILL.md", DEPLOY)
      await fixture.write("global/skills/global-demo/SKILL.md", TIDY)

      const twins = [
        nativeSkill("deploy", join(alias, "A/.opencode/skills/deploy/SKILL.md")),
        nativeSkill("foo", join(alias, "A/.opencode/skills/foo.md")),
      ]
      const natives = [
        ...twins,
        nativeSkill("native-root", join(alias, ".opencode/skills/native-root/SKILL.md")),
        nativeSkill("global-demo", join(alias, "global/skills/global-demo/SKILL.md")),
      ]
      const fake = fakeContext(natives, { directory: alias })

      const outcome = await createRegistry(fake.ctx).activate()

      const expected = [
        await nestedId(fixture, "B", "deploy", "B/.claude/skills/deploy/SKILL.md"),
        await nestedId(fixture, "C", "tidy", "C/.agents/skills/tidy/SKILL.md"),
        await nestedId(fixture, "D/deep/nest", "lint", "D/deep/nest/.opencode/skill/lint/SKILL.md"),
      ]
      const suppressed = [
        await nestedId(fixture, "A", "deploy", "A/.opencode/skills/deploy/SKILL.md"),
        await nestedId(fixture, "A", "foo", "A/.opencode/skills/foo.md"),
      ]

      const entries = fake.editor.list()
      const ids = entries.map((entry) => String(entry.id))
      const names = entries.map((entry) => String(entry.name))

      expect(entries).toHaveLength(7)
      for (const id of ["deploy", "foo", "native-root", "global-demo", ...expected]) {
        expect(ids).toContain(id)
      }
      for (const id of suppressed) expect(ids).not.toContain(id)
      expect(names).not.toContain("A/deploy")
      expect(names).not.toContain("A/foo")

      const owners = new Map<string, string[]>()
      for (const entry of entries) {
        const path = realpathSync(String(entry.path))
        owners.set(path, [...(owners.get(path) ?? []), String(entry.id)])
      }
      for (const group of owners.values()) expect(group).toHaveLength(1)

      expect(outcome.reloads).toBe(2)
      for (const id of suppressed) expect(outcome.diagnostics).toContain(`dedupe: ${id}`)
    } finally {
      unlinkSync(alias)
      await fixture.cleanup()
    }
  })
})
