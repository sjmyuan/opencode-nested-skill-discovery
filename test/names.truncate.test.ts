import { describe, expect, it } from "vitest"
import { truncateName } from "../src/names.ts"

const FITS_80 = `${"a".repeat(50)}/${"b".repeat(21)}/skill-x`
const OVER_81 = `${"a".repeat(51)}/${"b".repeat(21)}/skill-x`
const LONG_PATH = "packages/core/src/skill/deeply/nested/modules/feature-alpha/implementation-notes"
const LONG_NAME = `${LONG_PATH}/deploy`
const LONG_EXPECTED = "…/core/src/skill/deeply/nested/modules/feature-alpha/implementation-notes/deploy"
const TIER3 = `…/${"y".repeat(77)}…`

const length = (value: string): number => Array.from(value).length

describe("truncateName", () => {
  it("T1 keeps a short name", () => {
    expect(truncateName("opencode-v2.0.26/effect")).toBe("opencode-v2.0.26/effect")
    expect(length(truncateName("opencode-v2.0.26/effect"))).toBe(23)
  })

  it("T2 keeps a name of exactly 80", () => {
    expect(length(FITS_80)).toBe(80)
    expect(truncateName(FITS_80)).toBe(FITS_80)
    expect(length(truncateName(FITS_80))).toBe(80)
  })

  it("T3 drops the single over-long segment from the left", () => {
    expect(length(OVER_81)).toBe(81)
    expect(truncateName(OVER_81)).toBe(`…/${"b".repeat(21)}/skill-x`)
    expect(length(truncateName(OVER_81))).toBe(31)
  })

  it("T4 drops one segment of a long path", () => {
    expect(length(LONG_NAME)).toBe(87)
    expect(truncateName(LONG_NAME)).toBe(LONG_EXPECTED)
    expect(length(truncateName(LONG_NAME))).toBe(80)
  })

  it("T5 drops every segment that does not fit", () => {
    const input = `${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(40)}/deploy`

    expect(length(input)).toBe(129)
    expect(truncateName(input)).toBe(`…/${"c".repeat(40)}/deploy`)
    expect(length(truncateName(input))).toBe(49)
  })

  it("T6 keeps the native tail when the path is the excess", () => {
    const input = `${"p".repeat(60)}/rtl-aware-development`

    expect(length(input)).toBe(82)
    expect(truncateName(input)).toBe("…/rtl-aware-development")
    expect(length(truncateName(input))).toBe(23)
  })

  it("T7 cuts the native tail when the marker alone overflows", () => {
    const input = `pkg/${"y".repeat(80)}`

    expect(length(input)).toBe(84)
    expect(truncateName(input)).toBe(TIER3)
    expect(length(truncateName(input))).toBe(80)
  })

  it("T8 cuts a name that has no path at all", () => {
    const input = "x".repeat(81)

    expect(truncateName(input)).toBe(`${"x".repeat(79)}…`)
    expect(length(truncateName(input))).toBe(80)
  })

  it("T8b keeps an 80 code point name unchanged", () => {
    const input = "x".repeat(80)

    expect(truncateName(input)).toBe(input)
    expect(length(truncateName(input))).toBe(80)
  })

  it("T9 honours a small maxLength", () => {
    expect(truncateName("aaa/bbb/ccc", 10)).toBe("…/bbb/ccc")
    expect(length(truncateName("aaa/bbb/ccc", 10))).toBe(9)
  })

  it("T9b leaves a name that fits a small maxLength alone", () => {
    expect(truncateName("aaa/bbb/ccc", 20)).toBe("aaa/bbb/ccc")
  })

  it("T10 counts code points and never splits a surrogate pair", () => {
    const input = "😀".repeat(41)

    expect(input.length).toBe(82)
    expect(truncateName(input)).toBe(input)
    expect(length(truncateName(input))).toBe(41)
  })

  it("T11 is idempotent", () => {
    for (const input of [OVER_81, LONG_NAME, `pkg/${"y".repeat(80)}`, "x".repeat(81)]) {
      const once = truncateName(input)

      expect(truncateName(once)).toBe(once)
    }
  })
})
