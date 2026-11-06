import { describe, expect, it } from "vitest"
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from "../src/contracts.ts"
import { sanitizeText } from "../src/names.ts"

const cases = [
  { label: "S1 strips markup characters", input: `<script>alert("x")</script>`, expected: "scriptalert(x)/script" },
  { label: "S2 drops ampersands", input: "a & b", expected: "a b" },
  { label: "S3 folds newlines and tabs", input: "line one\nline two\r\nthree\tfour", expected: "line one line two three four" },
  { label: "S4 deletes C0, C1 and DEL", input: "a\u0000b\u0007c\u0090d\u007Fe", expected: "abcde" },
  { label: "S4b deletion leaves no double space", input: "a \u0000 b", expected: "a b" },
  { label: "S4c vertical tab and form feed separate words", input: "a\u000Bb\u000Cc", expected: "a b c" },
  { label: "S5 Unicode line separators collapse", input: "a\u2028b\u2029c", expected: "a b c" },
  { label: "S6 collapses and trims", input: "  a   b  ", expected: "a b" },
  { label: "S7 keeps non-Latin scripts", input: "日本語 — café ẞ", expected: "日本語 — café ẞ" },
  { label: "S7b keeps emoji", input: "ship it 🚀", expected: "ship it 🚀" },
  { label: "S8 cap is inclusive", input: "d".repeat(MAX_DESCRIPTION_LENGTH), expected: "d".repeat(MAX_DESCRIPTION_LENGTH) },
  { label: "S8b cuts one over the cap", input: "d".repeat(501), expected: "d".repeat(MAX_DESCRIPTION_LENGTH) },
  { label: "S8c cuts far over the cap", input: "d".repeat(600), expected: "d".repeat(MAX_DESCRIPTION_LENGTH) },
  { label: "S8d caps count code points", input: "😀".repeat(300), expected: "😀".repeat(300) },
  { label: "S9 cap never leaves a trailing space", input: `${"a".repeat(499)} bc`, expected: "a".repeat(499) },
] as const

describe("sanitizeText", () => {
  for (const c of cases) {
    it(c.label, () => {
      expect(sanitizeText(c.input, MAX_DESCRIPTION_LENGTH)).toBe(c.expected)
    })
  }

  it("S8e applies the name cap", () => {
    const out = sanitizeText("n".repeat(90), MAX_NAME_LENGTH)

    expect(Array.from(out)).toHaveLength(MAX_NAME_LENGTH)
    expect(out).toBe("n".repeat(MAX_NAME_LENGTH))
  })

  it("S9b cap on a name keeps no trailing space", () => {
    const out = sanitizeText("n".repeat(79) + " x", MAX_NAME_LENGTH)

    expect(out).toBe("n".repeat(79))
  })

  it("S10 is idempotent", () => {
    for (const c of cases) {
      const once = sanitizeText(c.input, MAX_DESCRIPTION_LENGTH)

      expect(sanitizeText(once, MAX_DESCRIPTION_LENGTH)).toBe(once)
    }
  })

  it("S11 leaves no markup, control or doubled whitespace", () => {
    for (const c of cases) {
      const out = sanitizeText(c.input, MAX_DESCRIPTION_LENGTH)

      expect(out).not.toMatch(/[<>"&]/)
      expect(out).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/)
      expect(out).not.toMatch(/\s{2,}/)
      expect(out).not.toMatch(/^\s|\s$/)
    }
  })
})
