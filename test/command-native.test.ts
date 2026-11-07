import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import type { NativeRootInput } from "../src/native.ts"
import { resolveNativeCommandNames } from "../src/command-native.ts"
import { createFixture, createOutside, type ScanFixture } from "./support/scan-fixtures.ts"

const cleanups: Array<() => Promise<void>> = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function input(f: ScanFixture, location: string): NativeRootInput {
  return {
    location,
    home: join(f.root, "home"),
    configDirectory: join(f.root, "home/.config/opencode"),
  }
}

/** D3: diagnostics keep the frozen grammar and never leak an absolute path. */
function expectFrozenGrammar(diagnostics: readonly string[], roots: readonly string[]): void {
  for (const line of diagnostics) {
    expect(line).toMatch(/^[a-z-]+: /)
    for (const root of roots) expect(line).not.toContain(root)
  }
}

describe("native command-name derivation", () => {
  it("derives deploy from an ancestor .opencode/command/deploy.md", async () => {
    const f = await fixture()
    await f.write("A/team/.opencode/command/deploy.md")
    const location = await f.mkdir("A/team/app")

    const index = await resolveNativeCommandNames(input(f, location))

    expect(index.names).toEqual(["deploy"])
    expect(index.complete).toBe(true)
    expect(index.diagnostics).toEqual([])
  })

  it("derives review/pr from commands/review/pr.md", async () => {
    const f = await fixture()
    await f.write("A/.opencode/commands/review/pr.md")
    const location = await f.mkdir("A/app")

    const index = await resolveNativeCommandNames(input(f, location))

    expect(index.names).toEqual(["review/pr"])
  })

  it("collects names from every ancestor up to the filesystem root", async () => {
    const f = await fixture()
    await f.write(".opencode/command/top.md")
    await f.write("A/.opencode/command/mid.md")
    await f.write("A/B/.opencode/command/near.md")
    const location = await f.mkdir("A/B/C")

    const index = await resolveNativeCommandNames(input(f, location))

    expect(index.names).toEqual(["mid", "near", "top"])
  })

  it("treats the location's own command roots as native", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/here.md")
    await f.write("A/.opencode/commands/also.md")

    const index = await resolveNativeCommandNames(input(f, join(f.realRoot, "A")))

    expect(index.names).toEqual(["also", "here"])
  })

  it("never collects a descendant subproject's command roots", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/hidden.md")

    const index = await resolveNativeCommandNames(input(f, f.realRoot))

    expect(index.names).toEqual([])
  })

  it("derives a name from a native file whose content would not decode", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/bad.md", "")
    await f.write("A/.opencode/command/ugly.md", "not frontmatter at all\n")

    const index = await resolveNativeCommandNames(input(f, join(f.realRoot, "A")))

    expect(index.names).toEqual(["bad", "ugly"])
  })

  it("matches native derivation for commands/commands/x.md, a:b.md, with space.md, dot.name.md", async () => {
    const f = await fixture()
    await f.write("A/.opencode/commands/commands/x.md")
    await f.write("A/.opencode/command/a:b.md")
    await f.write("A/.opencode/command/with space.md")
    await f.write("A/.opencode/command/dot.name.md")

    const index = await resolveNativeCommandNames(input(f, join(f.realRoot, "A")))

    expect(index.names).toEqual(["a:b", "commands/x", "dot.name", "with space"])
  })

  it("returns sorted unique names", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/dup.md")
    await f.write("A/.opencode/commands/dup.md")
    await f.write("A/.opencode/command/zeta.md")

    const index = await resolveNativeCommandNames(input(f, join(f.realRoot, "A")))

    expect(index.names).toEqual(["dup", "zeta"])
  })
})

describe("global config directory", () => {
  it("includes the global config directory when it exists", async () => {
    const f = await fixture()
    await f.write("home/.config/opencode/command/global.md")

    const index = await resolveNativeCommandNames(input(f, f.realRoot))

    expect(index.names).toEqual(["global"])
    expect(index.diagnostics).toEqual([])
  })

  it("skips a missing global config directory without a diagnostic", async () => {
    const f = await fixture()

    const index = await resolveNativeCommandNames(input(f, f.realRoot))

    expect(index.complete).toBe(true)
    expect(index.diagnostics).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)(
    "reports an unreadable global config directory as native-root-unreadable: global and marks the index incomplete",
    async () => {
      const f = await fixture()
      await f.mkdir("home/.config/opencode")
      await f.chmod("home/.config/opencode", 0o000)

      const index = await resolveNativeCommandNames(input(f, f.realRoot))

      expect(index.names).toEqual([])
      expect(index.complete).toBe(false)
      expect(index.diagnostics).toEqual(["native-root-unreadable: global"])
      expectFrozenGrammar(index.diagnostics, [f.root, f.realRoot])
    },
  )
})

describe("filesystem edges", () => {
  it("follows a file symlink and derives the name from the link path", async () => {
    const f = await fixture()
    const target = await f.write("shared/real.md")
    await f.symlink("A/.opencode/command/linked.md", target)

    const index = await resolveNativeCommandNames(input(f, join(f.realRoot, "A")))

    expect(index.names).toEqual(["linked"])
    expect(index.diagnostics).toEqual([])
  })

  it("does not descend a directory symlink and keeps the other names", async () => {
    const f = await fixture()
    const outside = await createOutside()
    cleanups.push(() => outside.cleanup())
    await outside.write("pkg/hidden.md")
    await f.write("A/.opencode/command/keep.md")
    await f.symlink("A/.opencode/command/pkg", join(outside.root, "pkg"))

    const index = await resolveNativeCommandNames(input(f, join(f.realRoot, "A")))

    expect(index.names).toEqual(["keep"])
    expect(index.diagnostics).toEqual([])
  })

  it("ignores a file named .opencode", async () => {
    const f = await fixture()
    await f.write(".opencode", "not a directory\n")

    const index = await resolveNativeCommandNames(input(f, f.realRoot))

    expect(index.names).toEqual([])
    expect(index.complete).toBe(true)
    expect(index.diagnostics).toEqual([])
  })
})

describe("budgets", () => {
  it("bounds the walk with the shared file budget", async () => {
    const f = await fixture()
    await f.write("A/.opencode/command/a.md")
    await f.write("A/.opencode/command/b.md")
    await f.write("A/.opencode/command/c.md")

    const index = await resolveNativeCommandNames(input(f, join(f.realRoot, "A")), {
      ...DEFAULT_SCAN_LIMITS,
      maxFiles: 2,
    })

    expect(index.names).toEqual(["a", "b"])
    expect(index.complete).toBe(false)
    expect(index.diagnostics).toEqual(["budget-files: maxFiles=2"])
    expectFrozenGrammar(index.diagnostics, [f.root, f.realRoot])
  })
})
