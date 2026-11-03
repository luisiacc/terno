import { cn } from "cn"
import { t } from "@terno/i18n"
import { Kbd } from "@terno/ui/components/kbd"

const SYMBOLS: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  ctrl: "⌃",
  enter: "↵",
  escape: "esc",
  backspace: "⌫",
  delete: "⌦",
  contextmenu: "☰",
  arrowup: "↑",
  arrowdown: "↓",
}

/** One key's keycap text: "escape" → "esc", "arrowup" → "↑". */
function keyLabel(key: string) {
  return SYMBOLS[key] ?? key.toUpperCase()
}

/** Renders a binding like "mod+k" or "g i" as keycaps. */
function Shortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <span data-slot="shortcut" className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.split(" ").map((chord, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="px-0.5 text-2xs text-muted-foreground">{t("ui.shortcut.then")}</span>}
          {chord.split("+").map((k) => (
            <Kbd key={k}>{keyLabel(k)}</Kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

export { Shortcut, keyLabel }
