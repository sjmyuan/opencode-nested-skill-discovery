import { rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { scopeTokenFor } from "../src/indexer.ts"
import { assembleEntries, buildRegistrySnapshot } from "../src/registry.ts"
import { createRegistryFixture, indexedSkill } from "./support/registry-fixtures.ts"

describe("registry snapshot grouping", () => {
  it("groups entries into one canonical snapshot per subproject", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A")
      await fixture.mkdirp("B")
      const root = await fixture.realpathOf(".")
      const subprojectA = await fixture.realpathOf("A")
      const subprojectB = await fixture.realpathOf("B")
      const skills = assembleEntries([
        indexedSkill({ id: "nested.a.1", subproject: "A" }),
        indexedSkill({ id: "nested.b.1", subproject: "B" }),
      ])

      const built = await buildRegistrySnapshot({ location: fixture.root, skills })

      expect(built.snapshot.location).toBe(root)
      expect(built.diagnostics).toEqual([])
      expect(built.snapshot.snapshots).toHaveLength(2)

      const byToken = new Map(built.snapshot.snapshots.map((snapshot) => [snapshot.scopeToken, snapshot]))

      expect(byToken.get(scopeTokenFor(subprojectA))?.directory).toBe(subprojectA)
      expect(byToken.get(scopeTokenFor(subprojectB))?.directory).toBe(subprojectB)
      expect(byToken.get(scopeTokenFor(subprojectA))?.skills.map((entry) => entry.id)).toEqual([
        "nested.a.1",
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  it("maps an empty subproject onto the location itself", async () => {
    const fixture = await createRegistryFixture()

    try {
      const root = await fixture.realpathOf(".")
      const skills = assembleEntries([indexedSkill({ id: "nested.root.1", subproject: "" })])

      const built = await buildRegistrySnapshot({ location: fixture.root, skills })

      expect(built.snapshot.snapshots).toHaveLength(1)
      expect(built.snapshot.snapshots[0]?.directory).toBe(root)
      expect(built.snapshot.snapshots[0]?.scopeToken).toBe(scopeTokenFor(root))
    } finally {
      await fixture.cleanup()
    }
  })

  it("sorts snapshots by scope token and entries by id", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A")
      await fixture.mkdirp("B")
      const skills = assembleEntries([
        indexedSkill({ id: "nested.b.2", subproject: "B" }),
        indexedSkill({ id: "nested.a.2", subproject: "A" }),
        indexedSkill({ id: "nested.a.1", subproject: "A" }),
        indexedSkill({ id: "nested.b.1", subproject: "B" }),
      ])

      const built = await buildRegistrySnapshot({ location: fixture.root, skills })
      const tokens = built.snapshot.snapshots.map((snapshot) => snapshot.scopeToken)

      expect(tokens).toEqual([...tokens].sort())
      for (const snapshot of built.snapshot.snapshots) {
        expect(snapshot.skills.map((entry) => entry.id)).toEqual(
          [...snapshot.skills.map((entry) => entry.id)].sort(),
        )
      }
      expect(built.snapshot.snapshots.flatMap((snapshot) => snapshot.skills)).toHaveLength(4)
    } finally {
      await fixture.cleanup()
    }
  })

  it("freezes the registry, its snapshots, and their entries", async () => {
    const fixture = await createRegistryFixture()

    try {
      const skills = assembleEntries([indexedSkill({ id: "nested.root.1", subproject: "" })])

      const built = await buildRegistrySnapshot({ location: fixture.root, skills })
      const [snapshot] = built.snapshot.snapshots

      expect(Object.isFrozen(built.snapshot)).toBe(true)
      expect(Object.isFrozen(built.snapshot.snapshots)).toBe(true)
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot?.skills)).toBe(true)
      expect(Object.isFrozen(snapshot?.skills[0])).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it("skips a subproject deleted between scan and grouping", async () => {
    const fixture = await createRegistryFixture()

    try {
      await fixture.mkdirp("A")
      await fixture.mkdirp("Gone")
      const subprojectA = await fixture.realpathOf("A")
      const skills = assembleEntries([
        indexedSkill({ id: "nested.a.1", subproject: "A" }),
        indexedSkill({ id: "nested.gone.1", subproject: "Gone" }),
      ])
      await rm(join(fixture.root, "Gone"), { recursive: true, force: true })

      const built = await buildRegistrySnapshot({ location: fixture.root, skills })

      expect(built.snapshot.snapshots).toHaveLength(1)
      expect(built.snapshot.snapshots[0]?.directory).toBe(subprojectA)
      expect(built.snapshot.snapshots[0]?.skills.map((entry) => entry.id)).toEqual(["nested.a.1"])
      expect(built.diagnostics).toHaveLength(1)
      expect(built.diagnostics[0]).toContain(`subproject: ${join(fixture.realRoot, "Gone")}:`)
    } finally {
      await fixture.cleanup()
    }
  })
})
