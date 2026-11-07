import { afterEach, describe, expect, it } from "vitest"
import type { NativeCommandNameIndex } from "../src/command-native.ts"
import { composeCommandNames, type QualifiedCommand } from "../src/command-names.ts"
import { dropNativeCollisions, type Nameable } from "../src/command-shadow.ts"
import { scanSkills } from "../src/scan.ts"
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

const nativeOf = (...names: string[]): NativeCommandNameIndex => ({
  names,
  complete: true,
  diagnostics: [],
})

/** F5's adapter: the drop compares the composed name, never the native root-relative one. */
const planned = (commands: readonly QualifiedCommand[]): Nameable[] =>
  commands.map((command) => ({ ...command, name: command.publishedName }))

async function composed(f: ScanFixture) {
  const scanned = await scanSkills({ location: f.realRoot })
  return composeCommandNames(scanned.commands, f.realRoot)
}

describe("composed names in the native pre-drop", () => {
  it("hands the composed name to the native drop so a native opencode:deploy removes it", async () => {
    const f = await fixture()
    await f.write("opencode/.opencode/command/deploy.md")

    const result = await composed(f)
    const outcome = dropNativeCollisions(planned(result.commands), { native: nativeOf("opencode:deploy") })

    expect(outcome.dropped.map((entry) => entry.name)).toEqual(["opencode:deploy"])
    expect(outcome.kept).toEqual([])
    expect(outcome.diagnostics).toEqual(["native-shadow: opencode:deploy"])
  })

  it("keeps a composed name when only its unqualified native name is native", async () => {
    const f = await fixture()
    await f.write("opencode/.opencode/command/deploy.md")

    const result = await composed(f)
    const outcome = dropNativeCollisions(planned(result.commands), { native: nativeOf("deploy") })

    expect(outcome.kept.map((entry) => entry.name)).toEqual(["opencode:deploy"])
    expect(outcome.dropped).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it("reports name-collision and native-shadow as two distinct mechanisms for one name", async () => {
    const f = await fixture()
    await f.write("a:b/.opencode/command/c.md")
    await f.write("a-b/.opencode/command/c.md")

    const result = await composed(f)
    const outcome = dropNativeCollisions(planned(result.commands), { native: nativeOf("a-b:c") })

    expect(result.diagnostics).toEqual(["name-collision: a-b:c (a:b/.opencode/command/c.md)"])
    expect(outcome.diagnostics).toEqual(["native-shadow: a-b:c"])
    expect(outcome.dropped.map((entry) => entry.name)).toEqual(["a-b:c"])
  })
})
