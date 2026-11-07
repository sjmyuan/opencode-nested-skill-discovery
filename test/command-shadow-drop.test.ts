import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import type { NativeCommandNameIndex } from "../src/command-native.ts"
import { resolveNativeCommandNames } from "../src/command-native.ts"
import { dropNativeCollisions, type Nameable } from "../src/command-shadow.ts"
import { createFixture, type ScanFixture } from "./support/scan-fixtures.ts"

const cleanups: Array<() => Promise<void>> = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function input(f: ScanFixture, location: string) {
  return {
    location,
    home: join(f.root, "home"),
    configDirectory: join(f.root, "home/.config/opencode"),
  }
}

async function nativeOf(f: ScanFixture, location: string): Promise<NativeCommandNameIndex> {
  return resolveNativeCommandNames(input(f, location))
}

function planned(...names: string[]): Nameable[] {
  return names.map((name) => ({ name, canonicalPath: `/repo/${name}.md` }))
}

function incomplete(names: readonly string[], diagnostics: readonly string[]): NativeCommandNameIndex {
  return { names, complete: false, diagnostics }
}

/** D3: diagnostics keep the frozen grammar and never leak an absolute path. */
function expectFrozenGrammar(diagnostics: readonly string[], roots: readonly string[]): void {
  for (const line of diagnostics) {
    expect(line).toMatch(/^[a-z-]+: /)
    for (const root of roots) expect(line).not.toContain(root)
  }
}

describe("native collision pre-drop", () => {
  it("drops a published name that equals an ancestor native name and reports it once", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/deploy.md")
    const native = await nativeOf(f, await f.mkdir("A/app"))

    const outcome = dropNativeCollisions(planned("deploy", "A:deploy"), { native })

    expect(outcome.dropped.map((entry) => entry.name)).toEqual(["deploy"])
    expect(outcome.kept.map((entry) => entry.name)).toEqual(["A:deploy"])
    expect(outcome.diagnostics).toEqual(["native-shadow: deploy"])
  })

  it("drops a published name that equals the location's own native name", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/here.md")
    const native = await nativeOf(f, join(f.realRoot, "A"))

    const outcome = dropNativeCollisions(planned("here"), { native })

    expect(outcome.dropped.map((entry) => entry.name)).toEqual(["here"])
    expect(outcome.diagnostics).toEqual(["native-shadow: here"])
  })

  it("keeps a nested command that only shares its unqualified name with a native command", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/deploy.md")
    const native = await nativeOf(f, await f.mkdir("A/app"))

    const outcome = dropNativeCollisions(planned("sub:deploy", "A:sub:deploy"), { native })

    expect(outcome.kept.map((entry) => entry.name)).toEqual(["sub:deploy", "A:sub:deploy"])
    expect(outcome.dropped).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it("keeps every name when the native index is complete and nothing matches", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/deploy.md")
    const native = await nativeOf(f, await f.mkdir("A/app"))

    const outcome = dropNativeCollisions(planned("sub:x", "sub:y"), { native })

    expect(native.complete).toBe(true)
    expect(outcome.kept.map((entry) => entry.name)).toEqual(["sub:x", "sub:y"])
    expect(outcome.diagnostics).toEqual([])
  })

  it("surfaces an incomplete native index once alongside the names it did see", async () => {
    const native = incomplete(["deploy"], ["native-root-unreadable: global"])

    const outcome = dropNativeCollisions(planned("deploy", "sub:x", "sub:x"), { native })

    expect(outcome.kept.map((entry) => entry.name)).toEqual(["sub:x", "sub:x"])
    expect(outcome.dropped.map((entry) => entry.name)).toEqual(["deploy"])
    expect(outcome.diagnostics).toEqual(["native-root-unreadable: global", "native-shadow: deploy"])
  })

  it("never reports the same drop twice across two identical passes", async () => {
    const native = incomplete(["deploy"], ["native-root-unreadable: global"])
    const names = planned("deploy", "sub:x")

    const first = dropNativeCollisions(names, { native })
    const denied = first.dropped.map((entry) => entry.name)
    const second = dropNativeCollisions(names, { native, denied })

    expect(first.diagnostics).toEqual(["native-root-unreadable: global", "native-shadow: deploy"])
    expect(second.dropped.map((entry) => entry.name)).toEqual(["deploy"])
    expect(second.diagnostics).toEqual(["native-root-unreadable: global"])
  })

  it("keeps the caller's order and drops deterministically", async () => {
    const native = incomplete(["sub:deploy", "sub:review/pr"], [])

    const outcome = dropNativeCollisions(planned("C:z", "sub:deploy", "sub:review/pr", "D:y"), { native })

    expect(outcome.kept.map((entry) => entry.name)).toEqual(["C:z", "D:y"])
    expect(outcome.dropped.map((entry) => entry.name)).toEqual(["sub:deploy", "sub:review/pr"])
    expect(outcome.diagnostics).toEqual(["native-shadow: sub:deploy", "native-shadow: sub:review/pr"])
  })

  it.skipIf(process.getuid?.() === 0)("emits frozen-grammar path-free diagnostics", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/deploy.md")
    await f.mkdir("home")
    await f.chmod("home", 0o000)
    const native = await nativeOf(f, join(f.realRoot, "A"))

    const outcome = dropNativeCollisions(planned("deploy", "sub:x"), { native })

    expect(outcome.diagnostics).toEqual(["native-root-unreadable: global", "native-shadow: deploy"])
    expectFrozenGrammar(outcome.diagnostics, [f.root, f.realRoot])
  })
})
