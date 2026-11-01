import { CUSTOM_PREFIX, THEME_TOKENS } from "@terno/core";
import { themeName, type Theme } from "@terno/ui/themes/registry";
import { cn } from "@terno/ui/lib/utils";
import { Check } from "@terno/ui/icons";

/**
 * A 132×84 live mini-mock of the app in a theme: sidebar, three rows (one
 * unread), the selected row with its rail and a primary pill. Tokens only,
 * inside its own [data-theme], so any theme renders next to any other.
 */
export function ThemePreview({ theme, base }: { theme: Theme; base: string }) {
  // custom themes: their full token map, set through React's style (CSSOM), never as CSS text
  const style = theme.id.startsWith(CUSTOM_PREFIX) ? (Object.fromEntries(THEME_TOKENS.map((k) => [`--${k}`, theme.tokens[k]])) as React.CSSProperties) : undefined;
  return (
    <div data-theme={base} style={style} className="flex h-[84px] w-[132px] overflow-hidden rounded-md border border-border bg-background font-sans text-foreground" aria-hidden>
      <div className="flex w-8 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-1.5">
        <span className="h-2 rounded-sm bg-primary" />
        <span className="h-1 w-4 rounded-full bg-muted-foreground" />
        <span className="h-1 w-3 rounded-full bg-muted-foreground" />
        <span className="mt-1 size-1.5 rounded-full bg-cat-amber" />
        <span className="size-1.5 rounded-full bg-cat-emerald" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-pane">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn("relative mx-0.5 flex h-[18px] shrink-0 flex-col justify-center gap-0.5 rounded-sm pr-1.5 pl-2", i === 1 ? "bg-row-selected" : "hairline-b")}>
            {i === 0 && <span className="absolute top-1/2 left-1 size-1 -translate-y-1/2 rounded-full bg-unread" />}
            <span className={cn("h-1 rounded-full", i === 1 ? "w-10 bg-row-selected-foreground" : "w-9 bg-foreground")} />
            <span className="h-0.5 w-14 rounded-full bg-muted-foreground" />
          </div>
        ))}
        <div className="flex flex-1 items-center justify-end px-1.5">
          <span className="h-2 w-7 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}

export function ThemeCard({ theme, base, selected, onSelect, note, name, testId }: { theme: Theme; base: string; selected: boolean; onSelect: () => void; note?: string; name?: string; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId ?? `theme-card-${theme.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn("flex flex-col gap-1.5 rounded-lg p-1.5 text-left hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", selected && "bg-accent text-accent-foreground hover:bg-accent")}
    >
      <ThemePreview theme={theme} base={base} />
      <span className="flex w-[132px] items-center gap-1 text-xs">
        <span className="truncate font-medium">{name ?? themeName(theme)}</span>
        {selected && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
      </span>
      {note && <span className="w-[132px] text-2xs">{note}</span>}
    </button>
  );
}
