// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { chordLabel, Shortcut, shortcutText } from "@terno/ui/components/shortcut"

describe("shortcut notation (plan 158)", () => {
  it("writes modifiers in Apple's order however the binding lists them", () => {
    expect(chordLabel("mod+shift+u", true)).toBe("⇧⌘U")
    expect(chordLabel("shift+mod+u", true)).toBe("⇧⌘U")
    expect(chordLabel("mod+ctrl+a", true)).toBe("⌃⌘A")
    expect(chordLabel("alt+shift+mod+k", true)).toBe("⌥⇧⌘K")
    expect(chordLabel("backspace", true)).toBe("⌫")
    expect(chordLabel("mod+enter", true)).toBe("⌘↵")
  })

  it("writes words off the Mac", () => {
    expect(chordLabel("mod+shift+u", false)).toBe("Ctrl+Shift+U")
    expect(chordLabel("mod+backspace", false)).toBe("Ctrl+Backspace")
    expect(chordLabel("escape", false)).toBe("Esc")
    expect(chordLabel("f6", false)).toBe("F6")
  })

  it("says a sequence as two presses", () => {
    expect(shortcutText("g i", true)).toBe("G then I")
  })

  it("draws one keycap per press, never one per modifier", () => {
    const kbds = (keys: string) => renderToStaticMarkup(<Shortcut keys={keys} />).match(/<kbd/g)?.length
    expect(kbds("mod+shift+u")).toBe(1)
    expect(kbds("g i")).toBe(2)
  })
})
