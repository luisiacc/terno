import { cn } from "cn"
import { Kbd } from "@unica/ui/components/kbd"

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

/** Renders a binding like "mod+k" or "g i" as keycaps. */
function Shortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <span data-slot="shortcut" className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.split(" ").map((chord, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="px-0.5 text-2xs text-muted-foreground">then</span>}
          {chord.split("+").map((k) => (
            <Kbd key={k}>{SYMBOLS[k] ?? k.toUpperCase()}</Kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

export { Shortcut }
