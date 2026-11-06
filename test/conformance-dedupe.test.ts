import { realpathSync, symlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createRegistry } from "../src/registry.ts"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"
import { createRegistryFixture } from "./support/registry-fixtures.ts"

const DOC = "---\nname: deploy\ndescription: Deploys\n---\n# Deploy\n\nDeploys.\n"

describe("conformance: symlinked location dedupe", () => {
  // F5 rework required; do not fix here. Evidence: runtime-conformance-smoke/evidence/skill-settled.json
  // (live probe on opencode v2.0.26: the alias-path native twin and the canonical nested entry both survive).
  it.fails("registers a symlinked location's native skill exactly once", async () => {
    const fixture = await createRegistryFixture()
    const alias = `${fixture.root}-alias`
    symlinkSync(fixture.root, alias, "dir")

    try {
      await fixture.write("A/.opencode/skills/deploy/SKILL.md", DOC)
      const canonical = await fixture.realpathOf("A/.opencode/skills/deploy/SKILL.md")
      const nativePath = join(alias, "A/.opencode/skills/deploy/SKILL.md")
      const fake = fakeContext([nativeSkill("deploy", nativePath)], { directory: alias })

      await createRegistry(fake.ctx).activate()

      const owners = fake.editor.list().filter((entry) => realpathSync(String(entry.path)) === canonical)
      expect(owners.map((entry) => String(entry.id))).toEqual(["deploy"])
    } finally {
      unlinkSync(alias)
      await fixture.cleanup()
    }
  })
})
