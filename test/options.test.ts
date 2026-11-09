import { homedir } from "node:os"
import { describe, expect, it } from "vitest"
import { DEFAULT_SCAN_LIMITS } from "../src/contracts.ts"
import { SCAN_LIMIT_KEYS, resolveScanLimits } from "../src/options.ts"

const KEYS = ["maxDepth", "maxDirectories", "maxFiles", "maxFileBytes", "maxTotalBytes"] as const

const INVALID = /^option-invalid: [A-Za-z]+=.+$/

/** RD3: a string is quoted so `"100"` stays distinguishable from `100`; anything else uses `String`. */
const shown = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value)

describe("resolveScanLimits", () => {
  it("lists the five budgets in defaults order", () => {
    expect(SCAN_LIMIT_KEYS).toEqual([...KEYS])
  })

  it.each([
    ["undefined", undefined],
    ["an empty object", {}],
    ["null", null],
    ["an array", []],
  ])("falls back to every default for %s", (_label, options) => {
    const resolved = resolveScanLimits(options)
    expect(resolved.limits).toEqual(DEFAULT_SCAN_LIMITS)
    expect(resolved.diagnostics).toEqual([])
  })

  it.each(KEYS)("honours %s when given alone", (key) => {
    const resolved = resolveScanLimits({ [key]: 7 })
    expect(resolved.limits[key]).toBe(7)
    expect(resolved.diagnostics).toEqual([])
  })

  it("honours all five together", () => {
    const resolved = resolveScanLimits({
      maxDepth: 1,
      maxDirectories: 2,
      maxFiles: 3,
      maxFileBytes: 4,
      maxTotalBytes: 5,
    })
    expect(resolved.limits).toEqual({
      maxDepth: 1,
      maxDirectories: 2,
      maxFiles: 3,
      maxFileBytes: 4,
      maxTotalBytes: 5,
    })
    expect(resolved.diagnostics).toEqual([])
  })

  it("accepts the ADR's own example", () => {
    expect(resolveScanLimits({ maxDirectories: 100_000 }).limits.maxDirectories).toBe(100_000)
  })

  it.each(KEYS)("accepts 0 for %s (an empty index, no diagnostic)", (key) => {
    const resolved = resolveScanLimits({ [key]: 0 })
    expect(resolved.limits[key]).toBe(0)
    expect(resolved.diagnostics).toEqual([])
  })

  it.each(KEYS)("rejects a wrong type for %s with one line", (key) => {
    for (const value of ["100", null, true, {}]) {
      const resolved = resolveScanLimits({ [key]: value })
      expect(resolved.limits[key]).toBe(DEFAULT_SCAN_LIMITS[key])
      expect(resolved.diagnostics.length).toBe(1)
      expect(resolved.diagnostics[0]).toMatch(INVALID)
      expect(resolved.diagnostics[0]).toBe(`option-invalid: ${key}=${shown(value)}`)
    }
  })

  it("renders a numeric string distinguishably from a number", () => {
    expect(resolveScanLimits({ maxDirectories: "100000" }).diagnostics).toEqual([
      'option-invalid: maxDirectories="100000"',
    ])
    expect(resolveScanLimits({ maxFiles: null }).diagnostics).toEqual(["option-invalid: maxFiles=null"])
    expect(resolveScanLimits({ maxDepth: true }).diagnostics).toEqual(["option-invalid: maxDepth=true"])
  })

  it.each(KEYS)("rejects a negative, NaN or infinite %s", (key) => {
    for (const [value, shown] of [
      [-1, "-1"],
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [Number.NEGATIVE_INFINITY, "-Infinity"],
    ] as const) {
      const resolved = resolveScanLimits({ [key]: value })
      expect(resolved.limits[key]).toBe(DEFAULT_SCAN_LIMITS[key])
      expect(resolved.diagnostics).toEqual([`option-invalid: ${key}=${shown}`])
    }
  })

  it("ignores unknown keys silently", () => {
    const resolved = resolveScanLimits({ maxDirectorie: 500, debug: true })
    expect(resolved.limits).toEqual(DEFAULT_SCAN_LIMITS)
    expect(resolved.diagnostics).toEqual([])
  })

  it("treats an explicitly undefined key as absent", () => {
    const resolved = resolveScanLimits({ maxFiles: undefined })
    expect(resolved.limits).toEqual(DEFAULT_SCAN_LIMITS)
    expect(resolved.diagnostics).toEqual([])
  })

  it("reports several rejected keys once each, in defaults order", () => {
    const resolved = resolveScanLimits({
      maxTotalBytes: -1,
      maxFiles: "7",
      maxDepth: true,
      maxFileBytes: Number.NaN,
    })
    expect(resolved.diagnostics).toEqual([
      "option-invalid: maxDepth=true",
      'option-invalid: maxFiles="7"',
      "option-invalid: maxFileBytes=NaN",
      "option-invalid: maxTotalBytes=-1",
    ])
  })

  it("honours a large finite value without a ceiling", () => {
    const resolved = resolveScanLimits({ maxTotalBytes: 1e15 })
    expect(resolved.limits.maxTotalBytes).toBe(1e15)
    expect(resolved.diagnostics).toEqual([])
  })

  it("honours a non-integer as a threshold", () => {
    const resolved = resolveScanLimits({ maxFiles: 2.5 })
    expect(resolved.limits.maxFiles).toBe(2.5)
    expect(resolved.diagnostics).toEqual([])
  })

  it("returns a frozen copy, independent of the input object", () => {
    const input: Record<string, number> = { maxFiles: 3 }
    const resolved = resolveScanLimits(input)
    expect(Object.isFrozen(resolved.limits)).toBe(true)
    input.maxFiles = 9
    expect(resolved.limits.maxFiles).toBe(3)
    expect(resolved.limits).not.toBe(input)
  })

  it("never leaks a path in a diagnostic", () => {
    const resolved = resolveScanLimits({ maxDepth: "x", maxFiles: -1 })
    expect(resolved.diagnostics.length).toBe(2)
    for (const line of resolved.diagnostics) {
      expect(line).not.toContain(process.cwd())
      expect(line).not.toContain(homedir())
      expect(line).not.toContain("/")
    }
  })
})
