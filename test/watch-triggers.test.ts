import { describe, expect, it } from "vitest"
import { createWatchSet } from "../src/watch.ts"
import { fakeWatch } from "./support/watch-fixtures.ts"

function watchSet(fake = fakeWatch()) {
  const events: string[] = []
  const diagnostics: string[] = []
  const set = createWatchSet({
    factory: fake.factory,
    onEvent: () => {
      events.push("event")
    },
    onDiagnostic: (message) => {
      diagnostics.push(message)
    },
  })

  return { fake, set, events, diagnostics }
}

describe("watch set", () => {
  it("opens one non-recursive handle per target", () => {
    const { fake, set } = watchSet()

    set.sync(["a", "b"])

    expect(fake.opened).toEqual(["a", "b"])
    expect(set.active()).toEqual(["a", "b"])
  })

  it("reconciles: closes what left, keeps what stayed, opens what arrived", () => {
    const { fake, set } = watchSet()

    set.sync(["a", "b"])
    set.sync(["b", "c"])

    expect(fake.closed).toEqual(["a"])
    expect(fake.opened).toEqual(["a", "b", "c"])
    expect(set.active()).toEqual(["b", "c"])
  })

  it("never reopens a directory that is already watched", () => {
    const { fake, set } = watchSet()

    set.sync(["a", "b"])
    set.sync(["a", "b"])
    set.sync(["b", "a"])

    expect(fake.opened).toEqual(["a", "b"])
    expect(fake.closed).toEqual([])
  })

  it("keeps watching the other directories when one factory call fails", () => {
    const { fake, set, diagnostics } = watchSet()
    fake.failOn("b", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))

    expect(() => set.sync(["a", "b", "c"])).not.toThrow()

    expect(diagnostics).toEqual(["watch: b: EACCES"])
    expect(set.active()).toEqual(["a", "c"])
  })

  it("forwards a directory event to the handler exactly once", () => {
    const { fake, set, events } = watchSet()
    set.sync(["a", "b"])

    fake.emit("b")

    expect(events).toHaveLength(1)
  })

  it("never lets a throwing handler escape into the watcher callback", () => {
    const fake = fakeWatch()
    const set = createWatchSet({
      factory: fake.factory,
      onEvent: () => {
        throw new Error("handler down")
      },
      onDiagnostic: () => undefined,
    })
    set.sync(["a"])

    expect(() => fake.emit("a")).not.toThrow()
  })

  it("closes every handle once and is idempotent", () => {
    const { fake, set } = watchSet()
    set.sync(["a", "b"])

    set.dispose()

    expect(fake.closed).toEqual(["a", "b"])
    expect(set.active()).toEqual([])

    const before = [...fake.closed]
    expect(() => set.dispose()).not.toThrow()
    expect(fake.closed).toEqual(before)
  })

  it("opens nothing after disposal", () => {
    const { fake, set } = watchSet()
    set.sync(["a"])
    set.dispose()

    set.sync(["b"])

    expect(fake.opened).toEqual(["a"])
    expect(set.active()).toEqual([])
  })
})
