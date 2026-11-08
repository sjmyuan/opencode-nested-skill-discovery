import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"

const REPO = fileURLToPath(new URL("..", import.meta.url))

/** The precondition `ctx.permission.assert` exists at: `dist/promise/permission.d.ts`. */
export const permissionHasAssert: "assert" extends keyof Plugin.Context["permission"] ? true : false = true

const json = (relative: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(REPO, relative), "utf8")) as Record<string, any>

const root = json("package.json")
const host = json("node_modules/@opencode/plugin/package.json")
const installedEffect = json("node_modules/effect/package.json")

describe("host baseline", () => {
  it("pins the host devDependency at 2.2.5", () => {
    expect(root.devDependencies["@opencode/plugin"]).toBe("2.2.5")
  })

  it("installs the pinned host", () => {
    expect(host.version).toBe("2.2.5")
  })

  it("keeps the host a devDependency", () => {
    expect(root.dependencies["@opencode/plugin"]).toBeUndefined()
  })

  it("declares effect at the version the host resolves", () => {
    expect(root.dependencies.effect).toBe(host.dependencies.effect)
  })

  it("resolves a single copy of effect", () => {
    expect(installedEffect.version).toBe(host.dependencies.effect)
    expect(existsSync(path.join(REPO, "node_modules/@opencode/plugin/node_modules/effect"))).toBe(false)
  })

  it("exposes the permission assert surface", () => {
    expect(permissionHasAssert).toBe(true)
  })
})
