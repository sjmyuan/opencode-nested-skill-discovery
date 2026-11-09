import { DEFAULT_SCAN_LIMITS } from "./contracts.ts"
import type { ScanLimits } from "./contracts.ts"

/** The five budgets, in `DEFAULT_SCAN_LIMITS` declaration order (ADR R8). */
export const SCAN_LIMIT_KEYS = [
  "maxDepth",
  "maxDirectories",
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
] as const

export type ScanLimitKey = (typeof SCAN_LIMIT_KEYS)[number]

export interface ResolvedScanLimits {
  readonly limits: ScanLimits
  readonly diagnostics: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** RD3: quote a string so `"100"` stays distinguishable from `100`; everything else is `String`. */
const show = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value)

/**
 * Resolves the five scan budgets from the host's plugin options (ADR R8, D6/R17).
 *
 * Fail-safe per key: a wrong type, a negative or a non-finite value costs that key's
 * default and exactly one `option-invalid: <key>=<value>` line — activation never fails.
 * `0` is a valid threshold, an unknown key is ignored, and no path is ever echoed.
 */
export function resolveScanLimits(options: unknown): ResolvedScanLimits {
  const limits: Record<ScanLimitKey, number> = { ...DEFAULT_SCAN_LIMITS }
  const diagnostics: string[] = []

  if (isRecord(options)) {
    for (const key of SCAN_LIMIT_KEYS) {
      const value = options[key]
      if (value === undefined) continue
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        limits[key] = value
        continue
      }
      diagnostics.push(`option-invalid: ${key}=${show(value)}`)
    }
  }

  return { limits: Object.freeze(limits), diagnostics }
}
