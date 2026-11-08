import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolvePlacement, withinBoundary } from "../src/placement.ts"

const created: string[] = []

const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "placement-resolve-")))
  created.push(root)
  return root
}

afterEach(() => {
  created.length = 0
})

describe("resolvePlacement", () => {
  it("treats an omitted or empty directory as absent", async () => {
    const root = scratch()
    await expect(resolvePlacement({ directory: undefined, caller: root, home: root })).resolves.toEqual({
      kind: "absent",
    })
    await expect(resolvePlacement({ directory: "", caller: root, home: root })).resolves.toEqual({ kind: "absent" })
  })

  it("uses an absolute path as given and resolves a relative one against the caller", async () => {
    const root = scratch()
    const absolute = join(root, "target")
    mkdirSync(absolute)

    await expect(resolvePlacement({ directory: absolute, caller: root, home: root })).resolves.toEqual({
      kind: "resolved",
      directory: absolute,
    })
    await expect(resolvePlacement({ directory: "target", caller: root, home: root })).resolves.toEqual({
      kind: "resolved",
      directory: absolute,
    })
  })

  it("expands ~ and ~/x against the injected home", async () => {
    const root = scratch()
    const home = join(root, "home")
    mkdirSync(join(home, "nested"), { recursive: true })

    await expect(resolvePlacement({ directory: "~", caller: root, home })).resolves.toEqual({
      kind: "resolved",
      directory: home,
    })
    await expect(resolvePlacement({ directory: "~/nested", caller: root, home })).resolves.toEqual({
      kind: "resolved",
      directory: join(home, "nested"),
    })
  })

  it("returns the canonical path when the destination is a symlink", async () => {
    const root = scratch()
    const real = join(root, "real")
    mkdirSync(real)
    symlinkSync(real, join(root, "link"))

    await expect(resolvePlacement({ directory: join(root, "link"), caller: root, home: root })).resolves.toEqual({
      kind: "resolved",
      directory: real,
    })
  })

  it("refuses a missing path and a file without throwing", async () => {
    const root = scratch()
    const file = join(root, "note.txt")
    writeFileSync(file, "x")

    const missing = await resolvePlacement({ directory: "gone", caller: root, home: root })
    expect(missing).toEqual({ kind: "refused", directory: join(root, "gone"), reason: expect.any(String) })

    const regular = await resolvePlacement({ directory: file, caller: root, home: root })
    expect(regular).toEqual({ kind: "refused", directory: file, reason: expect.any(String) })
  })
})

describe("withinBoundary", () => {
  const boundary = (destination: string, project = "/work/proj", worktrees: readonly string[] = []) =>
    withinBoundary({ destination, location: "/work/proj/A", project, worktrees })

  it("allows the caller's location and the wider project directory", () => {
    expect(boundary("/work/proj/A")).toBe(true)
    expect(boundary("/work/proj/A/nested")).toBe(true)
    expect(boundary("/work/proj/B")).toBe(true)
    expect(boundary("/work/proj")).toBe(true)
  })

  it("allows a listed worktree, including its root", () => {
    expect(boundary("/work/wt-1/deep", "/work/proj", ["/work/wt-1"])).toBe(true)
    expect(boundary("/work/wt-1", "/work/proj", ["/work/wt-1"])).toBe(true)
  })

  it("refuses a sibling that only shares a prefix", () => {
    expect(boundary("/work/proj-x/A")).toBe(false)
    expect(boundary("/work/proj-x", "/work/proj", ["/work/wt-1"])).toBe(false)
  })

  it("refuses anything outside every allowed root", () => {
    expect(boundary("/elsewhere")).toBe(false)
  })

  it("never widens the boundary when the project directory is the filesystem root", () => {
    expect(boundary("/elsewhere", "/")).toBe(false)
    expect(boundary("/elsewhere", "/", ["/work/wt-1"])).toBe(false)
    expect(boundary("/work/wt-1", "/", ["/work/wt-1"])).toBe(true)
  })
})
