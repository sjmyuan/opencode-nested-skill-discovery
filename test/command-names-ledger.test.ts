import { afterEach, describe, expect, it } from "vitest"
import { createNameLedger } from "../src/command-names.ts"
import { scanSkills } from "../src/scan.ts"
import { createFixture, type ScanFixture } from "./support/scan-fixtures.ts"

const cleanups: Array<() => Promise<void>> = []

async function fixture(): Promise<ScanFixture> {
  const f = await createFixture()
  cleanups.push(() => f.cleanup())
  return f
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function colliding(f: ScanFixture) {
  await f.write("a:b/.opencode/command/c.md")
  await f.write("a-b/.opencode/command/c.md")
  const scanned = await scanSkills({ location: f.realRoot })
  return scanned.commands
}

/** The next pass sees only the winner, so the collision has disappeared. */
async function winnerOnly(f: ScanFixture) {
  const scanned = await scanSkills({ location: f.realRoot })
  return scanned.commands.filter((command) => !command.subproject.includes(":"))
}

describe("name ledger", () => {
  it("returns no diagnostics on a second identical pass", async () => {
    const f = await fixture()
    const commands = await colliding(f)
    const ledger = createNameLedger()

    const first = ledger.compose(commands, f.realRoot)
    const second = ledger.compose(commands, f.realRoot)

    expect(first.diagnostics).toEqual(["name-collision: a-b:c (a:b/.opencode/command/c.md)"])
    expect(second.diagnostics).toEqual([])
  })

  it("returns the same composed command list on every pass", async () => {
    const f = await fixture()
    const commands = await colliding(f)
    const ledger = createNameLedger()

    const first = ledger.compose(commands, f.realRoot)
    const second = ledger.compose(commands, f.realRoot)

    expect(second.commands).toEqual(first.commands)
    expect(second.commands.map((entry) => entry.publishedName)).toEqual(["a-b:c"])
  })

  it("reports a collision again after it disappears and returns", async () => {
    const f = await fixture()
    const commands = await colliding(f)
    const ledger = createNameLedger()

    const first = ledger.compose(commands, f.realRoot)
    const gone = ledger.compose(await winnerOnly(f), f.realRoot)
    const back = ledger.compose(commands, f.realRoot)

    expect(first.diagnostics).toHaveLength(1)
    expect(gone.diagnostics).toEqual([])
    expect(back.diagnostics).toEqual(["name-collision: a-b:c (a:b/.opencode/command/c.md)"])
  })
})
