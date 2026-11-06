import { describe, expect, it, vi } from "vitest"
import { createBackstop } from "../src/backstop.ts"

const THROTTLE = 2000

function clocked(controls: {
  readonly inFlight?: () => Promise<unknown> | undefined
  readonly refresh?: () => Promise<unknown>
  readonly throttleMs?: number
}) {
  let at = 0
  const refresh = vi.fn(controls.refresh ?? (async () => undefined))
  const backstop = createBackstop({
    refresh,
    inFlight: controls.inFlight ?? (() => undefined),
    throttleMs: controls.throttleMs ?? THROTTLE,
    now: () => at,
  })

  return {
    backstop,
    refresh,
    set now(value: number) {
      at = value
    },
  }
}

describe("prompt backstop", () => {
  it("refreshes at most once per throttle window", async () => {
    const harness = clocked({})

    await harness.backstop.prompt()
    harness.now = 500
    await harness.backstop.prompt()
    harness.now = 1999
    await harness.backstop.prompt()
    expect(harness.refresh).toHaveBeenCalledTimes(1)

    harness.now = 2000
    await harness.backstop.prompt()
    expect(harness.refresh).toHaveBeenCalledTimes(2)
  })

  it("lets any completed refresh suppress the next prompt", async () => {
    const harness = clocked({})

    harness.backstop.observe(1000)
    harness.now = 1500
    await harness.backstop.prompt()
    expect(harness.refresh).not.toHaveBeenCalled()

    harness.now = 3000
    await harness.backstop.prompt()
    expect(harness.refresh).toHaveBeenCalledTimes(1)
  })

  it("waits for the in-flight refresh instead of starting a second one", async () => {
    let release: (() => void) | undefined
    let inFlight: Promise<unknown> | undefined
    const harness = clocked({ inFlight: () => inFlight })
    inFlight = new Promise<void>((resolve) => {
      release = resolve
    })

    let settled = false
    const pending = harness.backstop.prompt().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    release?.()
    await pending

    expect(settled).toBe(true)
    expect(harness.refresh).not.toHaveBeenCalled()
  })

  it("waits for a failing in-flight refresh without refreshing or rejecting", async () => {
    const harness = clocked({ inFlight: () => Promise.reject(new Error("scan down")) })

    await expect(harness.backstop.prompt()).resolves.toBeUndefined()

    expect(harness.refresh).not.toHaveBeenCalled()
  })

  it("resolves when its own refresh fails and still charges the window", async () => {
    const harness = clocked({
      refresh: async () => {
        throw new Error("scan down")
      },
    })

    await expect(harness.backstop.prompt()).resolves.toBeUndefined()
    expect(harness.refresh).toHaveBeenCalledTimes(1)

    harness.now = 1000
    await expect(harness.backstop.prompt()).resolves.toBeUndefined()
    expect(harness.refresh).toHaveBeenCalledTimes(1)
  })

  it("resolves even when the clock throws", async () => {
    const refresh = vi.fn(async () => undefined)
    const backstop = createBackstop({
      refresh,
      inFlight: () => undefined,
      throttleMs: THROTTLE,
      now: () => {
        throw new Error("clock down")
      },
    })

    await expect(backstop.prompt()).resolves.toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("stops refreshing after disposal and disposes idempotently", async () => {
    const harness = clocked({ throttleMs: 0 })

    await harness.backstop.dispose()
    await expect(harness.backstop.prompt()).resolves.toBeUndefined()
    expect(harness.refresh).not.toHaveBeenCalled()

    await expect(harness.backstop.dispose()).resolves.toBeUndefined()
  })
})
