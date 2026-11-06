import { describe, expect, it } from "vitest"
import { fakeContext } from "./support/fake-context.ts"

describe("fake context storage", () => {
  it("pages key-ascending with an exclusive cursor", async () => {
    const fake = fakeContext([], {
      storage: [
        ["nested/manifest/a", 1],
        ["nested/manifest/b", 2],
        ["nested/manifest/c", 3],
        ["other/key", 4],
      ],
    })

    const first = await fake.ctx.storage.scan({ prefix: "nested/manifest/", limit: 2 })

    expect(first.entries.map((entry) => entry.key)).toEqual(["nested/manifest/a", "nested/manifest/b"])
    expect(first.next).toBe("nested/manifest/b")

    const second = await fake.ctx.storage.scan({
      prefix: "nested/manifest/",
      limit: 2,
      after: first.next,
    })

    expect(second.entries.map((entry) => entry.key)).toEqual(["nested/manifest/c"])
    expect(second.next).toBeUndefined()
  })
})
