import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { nodeWatchFactory } from "../src/watch.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("node watch factory", () => {
  it("reports a change inside a real directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nested-watch-node-"))
    const changes: string[] = []
    const handle = nodeWatchFactory(directory, () => {
      changes.push("change")
    })

    try {
      await writeFile(join(directory, "SKILL.md"), "# Deploy\n")

      await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0), { timeout: 2000, interval: 20 })
    } finally {
      handle.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("closes idempotently and survives its directory disappearing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nested-watch-node-"))
    const handle = nodeWatchFactory(directory, () => undefined)

    await rm(directory, { recursive: true, force: true })
    await sleep(50)

    expect(() => handle.close()).not.toThrow()
    expect(() => handle.close()).not.toThrow()
  })

  // `persistent: false` is what keeps the host open no longer than the runtime needs;
  // the proof is that the suite exits on its own after these handles exist.
})
