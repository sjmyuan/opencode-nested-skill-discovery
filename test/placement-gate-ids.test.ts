import { describe, expect, it } from "vitest"
import type { RegistrySnapshot, Snapshot } from "../src/contracts.ts"
import { nestedIDsUnder } from "../src/placement.ts"

const entry = (id: string) => ({ id, canonicalPath: `/skills/${id}/SKILL.md`, name: id, content: "" })

const scope = (directory: string, ids: readonly string[]): Snapshot => ({
  scopeToken: directory.replaceAll("/", "-"),
  directory,
  skills: ids.map(entry),
})

const snapshotOf = (...scopes: readonly Snapshot[]): RegistrySnapshot => ({ location: "/root", snapshots: scopes })

describe("placement gate: the destination's indexed nested IDs", () => {
  it("returns a scope's own entries when the destination is that scope", () => {
    const snapshot = snapshotOf(scope("/root/A", ["nested.a.deploy", "nested.a.audit"]))

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual(["nested.a.audit", "nested.a.deploy"])
  })

  it("includes a scope inside the destination and sorts the result", () => {
    const snapshot = snapshotOf(
      scope("/root/A/deep", ["nested.deep.beta"]),
      scope("/root/A", ["nested.a.zulu", "nested.a.alpha"]),
    )

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual([
      "nested.a.alpha",
      "nested.a.zulu",
      "nested.deep.beta",
    ])
  })

  it("excludes the scope that contains the destination", () => {
    const snapshot = snapshotOf(scope("/root", ["nested.root.outside"]), scope("/root/A", ["nested.a.inside"]))

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual(["nested.a.inside"])
  })

  it("excludes a sibling scope", () => {
    const snapshot = snapshotOf(scope("/root/B", ["nested.b.other"]), scope("/root/A", ["nested.a.inside"]))

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual(["nested.a.inside"])
  })

  it("excludes a sibling whose name extends the destination", () => {
    const snapshot = snapshotOf(scope("/root/AB", ["nested.ab.other"]), scope("/root/A", ["nested.a.inside"]))

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual(["nested.a.inside"])
  })

  it("returns nothing when no scope sits inside the destination", () => {
    const snapshot = snapshotOf(scope("/root/B", ["nested.b.other"]), scope("/root", ["nested.root.other"]))

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual([])
    expect(nestedIDsUnder(snapshotOf(), "/root/A")).toEqual([])
  })

  it("includes a scope whose name starts with two dots", () => {
    const snapshot = snapshotOf(scope("/root/A/..x", ["nested.x.only"]))

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual(["nested.x.only"])
  })

  it("excludes a scope that climbs out of the destination", () => {
    const snapshot = snapshotOf(scope("/root/A/../B", ["nested.b.other"]))

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual([])
  })

  it("dedupes an ID that two scopes both carry", () => {
    const snapshot = snapshotOf(
      scope("/root/A", ["nested.a.dup", "nested.a.only"]),
      scope("/root/A/deep", ["nested.a.dup"]),
    )

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual(["nested.a.dup", "nested.a.only"])
  })

  it("leaves the snapshot untouched and returns a fresh array", () => {
    const snapshot = snapshotOf(scope("/root/A", ["nested.a.one"]))
    const before = structuredClone({ ...snapshot })

    const first = nestedIDsUnder(snapshot, "/root/A") as string[]
    first.push("nested.a.injected")

    expect(nestedIDsUnder(snapshot, "/root/A")).toEqual(["nested.a.one"])
    expect(nestedIDsUnder(snapshot, "/root/A")).not.toBe(nestedIDsUnder(snapshot, "/root/A"))
    expect(snapshot).toEqual(before)
  })
})
