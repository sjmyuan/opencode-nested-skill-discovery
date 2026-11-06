import { describe, expect, it, vi } from "vitest"
import { fakeContext, nativeSkill } from "./support/fake-context.ts"

vi.mock("@opencode/plugin", () => ({ Plugin: { define: (plugin: unknown) => plugin } }))

const entry = await import("../index.ts")
const core = await import("../src/plugin.ts")

describe("plugin definition", () => {
  it("default-exports only the id and setup", () => {
    expect(Object.keys(entry.default).sort()).toEqual(["id", "setup"])
    expect(entry.default.id).toBe("nested-skill-discovery")
  })

  it("registers exactly one skill transform and disposes it once", async () => {
    const fake = fakeContext()
    const cleanup = await entry.default.setup(fake.ctx)

    expect(fake.transforms).toHaveLength(1)
    expect(cleanup).toBeTypeOf("function")
    if (typeof cleanup !== "function") return

    await cleanup()
    expect(fake.disposeCalls).toBe(1)
  })
})

describe("empty snapshot replay", () => {
  it("leaves a native entry untouched", async () => {
    const seed = nativeSkill("native-alpha")
    const fake = fakeContext([seed])
    await entry.default.setup(fake.ctx)

    const transform = fake.transforms[0]
    expect(transform).toBeDefined()
    transform!(fake.editor)

    expect(fake.editor.list()).toEqual([seed])
  })

  it("tolerates an undefined snapshot", () => {
    const fake = fakeContext()

    expect(() => core.applySnapshot(fake.editor, undefined)).not.toThrow()
  })

  it("freezes the empty snapshot", () => {
    expect(Object.isFrozen(core.EMPTY_SNAPSHOT)).toBe(true)
    expect(Object.isFrozen(core.EMPTY_SNAPSHOT.skills)).toBe(true)
    expect(core.EMPTY_SNAPSHOT.skills).toHaveLength(0)
  })
})
