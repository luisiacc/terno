import { t, type TextKey } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";

type Hint = { example: Extract<TextKey, `search.help.${string}.example`>; text: Extract<TextKey, `search.help.${string}.text`>; types?: "whole" | "quote" };

/** What parseSearch understands, the way a person would use it. A click types up to the colon; `whole`: it's complete by itself; `quote`: the opening quote. */
const HINTS: readonly Hint[] = [
  { example: "search.help.from.example", text: "search.help.from.text" },
  { example: "search.help.subject.example", text: "search.help.subject.text" },
  { example: "search.help.attachment.example", text: "search.help.attachment.text", types: "whole" },
  { example: "search.help.unread.example", text: "search.help.unread.text", types: "whole" },
  { example: "search.help.place.example", text: "search.help.place.text" },
  { example: "search.help.date.example", text: "search.help.date.text" },
  { example: "search.help.phrase.example", text: "search.help.phrase.text", types: "quote" },
];

/**
 * Plan 158: what a search can do, said before it's needed. `onPick`: the rows type themselves into the field (in the
 * panel under it); without, they only read (the reader, with no results).
 */
export function SearchHelp({ onPick, scope }: { onPick?: (text: string) => void; scope?: string }) {
  const row = "flex h-7 min-w-0 items-center gap-3 rounded-md px-2 text-xs";
  return (
    <div data-testid="search-help">
      <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("search.help.title")}</p>
      {HINTS.map(({ example, text, types }) => {
        const shown = t(example);
        const body = (
          <>
            <code className="w-28 shrink-0 truncate font-sans font-medium text-foreground">{shown}</code>
            <span className="min-w-0 truncate text-muted-foreground">{t(text)}</span>
          </>
        );
        if (!onPick) return <div key={example} className={row}>{body}</div>;
        return (
          // the field keeps focus and the caret: the row only types
          <button key={example} type="button" data-testid="search-help-row" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(types === "whole" ? `${shown} ` : types === "quote" ? '"' : shown.slice(0, shown.indexOf(":") + 1))} className={cn(row, "w-full text-left transition-colors duration-fast hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}>
            {body}
          </button>
        );
      })}
      {scope && <p data-testid="search-help-scope" className="hairline-t mt-1 px-2 pt-2 pb-1 text-xs text-muted-foreground">{scope}</p>}
    </div>
  );
}
