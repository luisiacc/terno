import { t, type TextKey } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import { useId, useRef, useState } from "react";

type Hint = { example: Extract<TextKey, `search.help.${string}.example`>; text: Extract<TextKey, `search.help.${string}.text`>; types?: "whole" | "quote" | "value" };

/** What parseSearch understands, the way a person would use it. A click types up to the colon; `whole`: it's complete by itself; `quote`: the opening quote; `value`: only its own values follow the colon (a place, a date), so words go beside it. */
const HINTS: readonly Hint[] = [
  { example: "search.help.from.example", text: "search.help.from.text" },
  { example: "search.help.subject.example", text: "search.help.subject.text" },
  { example: "search.help.attachment.example", text: "search.help.attachment.text", types: "whole" },
  { example: "search.help.unread.example", text: "search.help.unread.text", types: "whole" },
  { example: "search.help.place.example", text: "search.help.place.text", types: "value" },
  { example: "search.help.date.example", text: "search.help.date.text", types: "value" },
  { example: "search.help.phrase.example", text: "search.help.phrase.text", types: "quote" },
];

/** What a row types: its operator alone, or around a query that found nothing ("pago" → from:pago, pago has:attachment, pago in:archive, "pago") */
export function picked(shown: string, types: Hint["types"], around: string): string {
  const words = around.trim();
  // plain words are put to use; a query with operators or quotes of its own is kept, the row added after it
  const plain = words !== "" && !/[:"]/.test(words);
  if (types === "whole" || (types === "value" && words)) return words ? `${words} ${shown} ` : `${shown} `;
  if (types === "quote") return plain ? `"${words}"` : words ? `${words} "` : '"';
  const op = shown.slice(0, shown.indexOf(":") + 1);
  return plain && !/\s/.test(words) ? `${op}${words}` : words ? `${words} ${op}` : op;
}

/**
 * Plan 158: what a search can do, said before it's needed: under the field while it's empty, and in the list when a
 * search found nothing. A row types itself into the field (`around`: the query that found nothing, put to use). The rows
 * are one Tab stop, a list the arrows go through: seven stops in the list's header was a lot for a hint.
 */
export function SearchHelp({ onPick, scope, around = "" }: { onPick?: (text: string) => void; scope?: string; around?: string }) {
  const row = "flex h-7 min-w-0 items-center gap-3 rounded-md px-2 text-xs";
  const titleId = useId();
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const move = (e: React.KeyboardEvent) => {
    const last = HINTS.length - 1;
    const next = e.key === "ArrowDown" ? Math.min(active + 1, last) : e.key === "ArrowUp" ? Math.max(active - 1, 0) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    list.current?.querySelectorAll<HTMLElement>("[data-testid=search-help-row]")[next]?.focus();
  };
  return (
    <div data-testid="search-help">
      <p id={titleId} className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("search.help.title")}</p>
      <div ref={list} {...(onPick ? { role: "listbox", "aria-labelledby": titleId, onKeyDown: move } : {})}>
        {HINTS.map(({ example, text, types }, i) => {
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
            <button
              key={example}
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={i === active ? 0 : -1}
              data-testid="search-help-row"
              onMouseDown={(e) => e.preventDefault()}
              onFocus={() => setActive(i)}
              onClick={() => onPick(picked(shown, types, around))}
              className={cn(row, "w-full text-left transition-colors duration-fast hover:bg-muted focus-visible:bg-muted focus-visible:outline-none")}
            >
              {body}
            </button>
          );
        })}
      </div>
      {scope && <p data-testid="search-help-scope" className="hairline-t mt-1 px-2 pt-2 pb-1 text-xs text-muted-foreground">{scope}</p>}
    </div>
  );
}
