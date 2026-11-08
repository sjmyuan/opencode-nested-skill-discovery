import { describe, expect, it } from "vitest"
import { isPathInside } from "../src/path.ts"

describe("isPathInside", () => {
  it("accepts a path equal to its parent", () => {
    expect(isPathInside("/root", "/root")).toBe(true)
  })

  it("accepts a direct and a deep child", () => {
    expect(isPathInside("/root", "/root/child")).toBe(true)
    expect(isPathInside("/root", "/root/child/deep/leaf")).toBe(true)
  })

  it("accepts a child whose name starts with two dots", () => {
    expect(isPathInside("/root", "/root/..cache")).toBe(true)
    expect(isPathInside("/root", "/root/..cache/sc")).toBe(true)
  })

  it("refuses the parent segment itself and a sibling it reaches", () => {
    expect(isPathInside("/root", "/root/..")).toBe(false)
    expect(isPathInside("/root", "/root/../sibling")).toBe(false)
  })

  it("refuses a sibling that only shares a prefix", () => {
    expect(isPathInside("/root/proj", "/root/proj-x")).toBe(false)
  })

  it("refuses an unrelated path", () => {
    expect(isPathInside("/root", "/elsewhere")).toBe(false)
  })

  it("compares lexically, ignoring a redundant separator", () => {
    expect(isPathInside("/root", "/root//child")).toBe(true)
  })
})
