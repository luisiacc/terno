import { describe, expect, it } from "vitest"
import { wholeRowsHeight } from "./whole-rows"

describe("a list ends on a whole row (plan 160)", () => {
  // rows 32 px tall, 2 px apart, from an 8 px padding: 8..40, 42..74, 76..108, …
  const rows = Array.from({ length: 12 }, (_, i) => ({ top: 8 + 34 * i, bottom: 40 + 34 * i }))

  it("everything fits: no cap", () => {
    expect(wholeRowsHeight(300, rows, 8, 308)).toBeNull()
  })

  it("too tall: it ends on the last whole row, short of where the next one starts (no row peeks into the padding)", () => {
    // the row ending at 278 fits; its 8 px of padding would reach 286, past the next row's top at 280
    expect(wholeRowsHeight(420, rows, 8, 308)).toBe(280)
  })

  it("a gap wider than the padding keeps the whole padding", () => {
    expect(wholeRowsHeight(420, [{ top: 8, bottom: 40 }, { top: 60, bottom: 92 }, { top: 94, bottom: 126 }], 8, 90)).toBe(48)
  })

  it("rows out of order (groups) still find the lowest that fits", () => {
    expect(wholeRowsHeight(420, [rows[2]!, rows[0]!, rows[1]!], 8, 100)).toBe(76)
  })

  it("no row fits: the limit, never negative", () => {
    expect(wholeRowsHeight(420, rows, 8, 20)).toBe(20)
    expect(wholeRowsHeight(420, rows, 8, -5)).toBe(0)
  })
})
