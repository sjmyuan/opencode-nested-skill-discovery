import { describe, expect, it } from "vitest"
import type { NativeCommandNameIndex } from "../src/command-native.ts"
import {
  createShadowTracker,
  type Nameable,
  type PublishedCommand,
} from "../src/command-shadow.ts"

const noNative: NativeCommandNameIndex = { names: [], complete: true, diagnostics: [] }

function nativeOf(names: readonly string[]): NativeCommandNameIndex {
  return { names, complete: true, diagnostics: [] }
}

function planned(...names: string[]): Nameable[] {
  return names.map((name) => ({ name, canonicalPath: `/repo/${name}.md` }))
}

function published(name: string, description?: string): PublishedCommand {
  return { name, canonicalPath: `/repo/${name}.md`, description }
}

function namesOf(entries: readonly Nameable[]): readonly string[] {
  return entries.map((entry) => entry.name)
}

describe("shadow ledger", () => {
  it("a shadowed entry leaves the next snapshot", () => {
    const tracker = createShadowTracker()
    const snapshot = planned("A:deploy", "A:other")

    tracker.drop(snapshot, noNative)
    tracker.audit({
      listed: [{ name: "A:deploy", description: "theirs" }],
      published: [published("A:deploy", "ours")],
      native: noNative,
    })

    const next = tracker.drop(snapshot, noNative)

    expect(namesOf(next.kept)).toEqual(["A:other"])
    expect(namesOf(next.dropped)).toEqual(["A:deploy"])
  })

  it("keeps a denial while a native file or the listing still holds the name", () => {
    const shadow = (tracker: ReturnType<typeof createShadowTracker>): void => {
      tracker.audit({
        listed: [{ name: "A:deploy", description: "theirs" }],
        published: [published("A:deploy", "ours")],
        native: noNative,
      })
    }
    const snapshot = planned("A:deploy")

    const listed = createShadowTracker()
    shadow(listed)
    listed.audit({ listed: [{ name: "A:deploy" }], published: [], native: noNative })

    const native = createShadowTracker()
    shadow(native)
    native.audit({ listed: [], published: [], native: nativeOf(["A:deploy"]) })

    expect(namesOf(listed.drop(snapshot, noNative).dropped)).toEqual(["A:deploy"])
    expect(namesOf(native.drop(snapshot, noNative).dropped)).toEqual(["A:deploy"])
  })

  it("forgets a denial when neither holds it so a later pass may publish again", () => {
    const tracker = createShadowTracker()
    const snapshot = planned("A:deploy")

    tracker.audit({
      listed: [{ name: "A:deploy", description: "theirs" }],
      published: [published("A:deploy", "ours")],
      native: noNative,
    })
    tracker.audit({ listed: [], published: [], native: noNative })

    const next = tracker.drop(snapshot, noNative)

    expect(namesOf(next.kept)).toEqual(["A:deploy"])
    expect(next.diagnostics).toEqual([])
  })

  it("emits no diagnostic on a rescan with no changes", () => {
    const tracker = createShadowTracker()
    const snapshot = planned("A:deploy", "A:other")
    const native = nativeOf(["A:deploy"])
    const audit = {
      listed: [{ name: "A:deploy", description: "theirs" }],
      published: [published("A:deploy", "ours")],
      native,
    }

    const firstDrop = tracker.drop(snapshot, native)
    const firstAudit = tracker.audit(audit)
    const secondDrop = tracker.drop(snapshot, native)
    const secondAudit = tracker.audit(audit)

    expect(firstDrop.diagnostics).toEqual(["native-shadow: A:deploy"])
    expect(firstAudit.diagnostics).toEqual(["native-shadow-audit: A:deploy"])
    expect(secondDrop.diagnostics).toEqual([])
    expect(secondAudit.diagnostics).toEqual([])
  })

  it("never denies an entry that is merely absent from the listing", () => {
    const tracker = createShadowTracker()
    const snapshot = planned("A:deploy")

    tracker.audit({ listed: [], published: [published("A:deploy", "ours")], native: noNative })

    expect(namesOf(tracker.drop(snapshot, noNative).kept)).toEqual(["A:deploy"])
  })

  it("a seeded name is dropped before the first replay", () => {
    const tracker = createShadowTracker()
    tracker.seed(["gitlab:review-pr"])

    const next = tracker.drop(planned("gitlab:review-pr", "A:other"), noNative)

    expect(namesOf(next.kept)).toEqual(["A:other"])
    expect(namesOf(next.dropped)).toEqual(["gitlab:review-pr"])
    expect(next.diagnostics).toEqual(["native-shadow: gitlab:review-pr"])
  })

  it("a seeded drop is reported once and adds no rule", () => {
    const tracker = createShadowTracker()
    tracker.seed(["gitlab:review-pr"])
    const snapshot = planned("gitlab:review-pr", "A:other")

    const first = tracker.drop(snapshot, noNative)
    const second = tracker.drop(snapshot, noNative)

    expect(namesOf(second.dropped)).toEqual(["gitlab:review-pr"])
    expect(first.diagnostics).toEqual(["native-shadow: gitlab:review-pr"])
    expect(second.diagnostics).toEqual([])
  })

  it("seeding is additive and idempotent", () => {
    const tracker = createShadowTracker()
    tracker.seed(["a"])
    tracker.seed(["b"])
    tracker.seed(["a"])

    const next = tracker.drop(planned("a", "b", "c"), noNative)

    expect(namesOf(next.kept)).toEqual(["c"])
    expect(namesOf(next.dropped)).toEqual(["a", "b"])
  })

  it("a seeded name is held by the audit", () => {
    const tracker = createShadowTracker()
    tracker.seed(["A:deploy"])
    tracker.audit({
      listed: [{ name: "A:deploy", description: "theirs" }],
      published: [published("A:deploy", "ours")],
      native: noNative,
    })
    tracker.audit({ listed: [], published: [], native: noNative })

    expect(namesOf(tracker.drop(planned("A:deploy"), noNative).dropped)).toEqual(["A:deploy"])
  })

  it("is deterministic across passes in kept, dropped and diagnostic order", () => {
    const run = () => {
      const tracker = createShadowTracker()
      const native = nativeOf(["B:other"])
      const snapshot = planned("C:z", "A:deploy", "B:other")
      const audit = {
        listed: [{ name: "A:deploy", description: "theirs" }],
        published: [published("A:deploy", "ours")],
        native,
      }

      return {
        first: tracker.drop(snapshot, native),
        shadow: tracker.audit(audit),
        second: tracker.drop(snapshot, native),
      }
    }

    const result = run()

    expect(run()).toEqual(result)
    expect(namesOf(result.first.kept)).toEqual(["C:z", "A:deploy"])
    expect(namesOf(result.first.dropped)).toEqual(["B:other"])
    expect(namesOf(result.second.kept)).toEqual(["C:z"])
    expect(namesOf(result.second.dropped)).toEqual(["A:deploy", "B:other"])
    expect(result.first.diagnostics).toEqual(["native-shadow: B:other"])
    expect(result.second.diagnostics).toEqual([])
  })
})
