import { cn } from "cn"
import { t } from "@terno/i18n"
import { Kbd } from "@terno/ui/components/kbd"

/** The platform the keys are drawn for: a Mac's glyphs, or Ctrl+… words elsewhere */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

const GLYPHS: Record<string, string> = {
  enter: "↵",
  escape: "esc",
  backspace: "⌫",
  delete: "⌦",
  contextmenu: "☰",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
}
/** Off the Mac, the keys a glyph wouldn't say */
const WORDS: Record<string, string> = { escape: "Esc", backspace: "Backspace", delete: "Del", contextmenu: "Menu", enter: "Enter" }

/** Modifiers in Apple's order (⌃⌥⇧⌘), and in the order and names Windows and Linux print (Ctrl+Alt+Shift) */
const MAC_ORDER = ["ctrl", "alt", "shift", "mod", "meta"] as const
const PC_ORDER = ["mod", "ctrl", "meta", "alt", "shift"] as const
const MAC_MODIFIER: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘", meta: "⌘" }
const PC_MODIFIER: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", mod: "Ctrl", meta: "Win" }

/** One key's keycap text: "escape" → "esc", "arrowup" → "↑", "u" → "U". */
function keyLabel(key: string, mac = IS_MAC) {
  return (mac ? GLYPHS[key] : (WORDS[key] ?? GLYPHS[key])) ?? (key.length === 1 ? key.toUpperCase() : `${key[0]!.toUpperCase()}${key.slice(1)}`)
}

/**
 * Plan 158: one chord as one keycap's text, the same on every surface. "mod+shift+u" → "⇧⌘U" on a Mac (Apple's order,
 * whatever order the binding was written in), "Ctrl+Shift+U" elsewhere.
 */
function chordLabel(chord: string, mac = IS_MAC): string {
  const parts = chord.split("+")
  // "+" itself: a binding of the plus key ends with an empty part
  const key = parts.at(-1) === "" ? "+" : parts.at(-1)!
  const mods = (mac ? MAC_ORDER : PC_ORDER).filter((m) => parts.slice(0, -1).includes(m))
  return mac ? `${mods.map((m) => MAC_MODIFIER[m]).join("")}${keyLabel(key, mac)}` : [...mods.map((m) => PC_MODIFIER[m]), keyLabel(key, mac)].join("+")
}

/** A binding as plain text, for a sentence or a screen reader: "⇧⌘U", "G then I". */
function shortcutText(keys: string, mac = IS_MAC): string {
  return keys.split(" ").map((chord) => chordLabel(chord, mac)).join(` ${t("ui.shortcut.then")} `)
}

/**
 * The app's one way to draw a shortcut (plan 158): a binding like "mod+shift+u" or "g i" as one keycap per press
 * ("then" between two presses), in menus, the palette, tooltips, buttons and the shortcuts sheet alike.
 */
function Shortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <span data-slot="shortcut" className={cn("inline-flex items-center gap-1", className)}>
      {keys.split(" ").map((chord, i) => (
        <span key={i} className="contents">
          {i > 0 && <span className="text-xs font-normal text-muted-foreground">{t("ui.shortcut.then")}</span>}
          <Kbd>{chordLabel(chord)}</Kbd>
        </span>
      ))}
    </span>
  )
}

export { Shortcut, chordLabel, keyLabel, shortcutText }
