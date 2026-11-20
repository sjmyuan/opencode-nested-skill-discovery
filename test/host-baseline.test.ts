import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Result, SchemaParser } from "effect"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Permission } from "@opencode/schema/permission"
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

/**
 * F16 Step 2: the agent decode surface needs a JSONC parser, a YAML frontmatter parser,
 * and the host's own config schema. All three are exact pins, and the schema package must
 * not drag a second `effect` copy in beside the one the host resolves (AQ5).
 */
describe("decode dependencies", () => {
  it("declares the host schema package at its pinned version", () => {
    expect(root.dependencies["@opencode/schema"]).toBe("2.2.5")
    expect(json("node_modules/@opencode/schema/package.json").version).toBe("2.2.5")
  })

  it("pins the two parsers exactly", () => {
    expect(root.dependencies["jsonc-parser"]).toBe("3.3.1")
    expect(root.dependencies["gray-matter"]).toBe("4.0.3")
    expect(json("node_modules/jsonc-parser/package.json").version).toBe("3.3.1")
    expect(json("node_modules/gray-matter/package.json").version).toBe("4.0.3")
  })

  it("keeps the schema package on the host's effect version without a second copy", () => {
    expect(json("node_modules/@opencode/schema/package.json").dependencies.effect).toBe(installedEffect.version)
    expect(existsSync(path.join(REPO, "node_modules/@opencode/schema/node_modules/effect"))).toBe(false)
  })

  it("decodes an agent entry strictly enough for the legacy guard", () => {
    const decode = SchemaParser.decodeUnknownResult(ConfigAgent.Info)
    const accepted = decode({ system: "x" })
    expect(Result.isSuccess(accepted) ? accepted.success.system : undefined).toBe("x")
    // `ConfigAgent.Info` accepts `{ system }` alone, so the legacy predicate is load-bearing.
    expect(Result.isSuccess(decode({ name: "x", system: "y" }))).toBe(true)
    expect(Result.isFailure(decode({ mode: "nope" }))).toBe(true)
  })

  it("exposes the permission ruleset the read set projects", () => {
    const decoded = SchemaParser.decodeUnknownResult(Permission.Ruleset)([
      { action: "read", resource: "**", effect: "allow" },
    ])
    expect(Result.isSuccess(decoded) ? decoded.success.length : -1).toBe(1)
    expect(Result.isFailure(SchemaParser.decodeUnknownResult(Permission.Ruleset)([{ action: "read" }]))).toBe(true)
  })
})
