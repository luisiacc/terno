import type { Address } from "@terno/core";
import { t } from "@terno/i18n";
import { fold } from "@terno/store/fold";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { prefetchRecipientInitials, recipientInitials, suggestRecipients, warmAutocomplete } from "~/lib/autocomplete";
import { acceptAt, emailsIn, highlight, pastedAddresses, pasteInto, tokenAt, type TypedToken } from "~/lib/recipients";
import { SenderAvatar } from "./sender-avatar";

/**
 * A recipient field with suggestions (plan 18): a combobox over the draft's
 * text field. Each keystroke asks the backend's in-memory index about the
 * address being typed (answers to older keystrokes are dropped); the list is
 * portaled under the field (the draft's surface clips), focus never leaves
 * the input. ↑/↓ move, Enter or Tab accept, Esc closes, `,`/`;` accept what
 * is highlighted unless a complete address was typed.
 */
export function RecipientInput({
  id,
  testId,
  value,
  onChange,
  accountId,
  others,
  className,
  placeholder,
}: {
  id: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  accountId: number;
  /** the draft's other recipient fields (their addresses aren't suggested again) */
  others: readonly string[];
  className?: string;
  placeholder?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Address[]>([]);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const seq = useRef(0);
  const token = useRef<TypedToken | null>(null);
  const caretAfter = useRef<number | null>(null);
  const open = items.length > 0;

  const close = () => {
    seq.current++;
    setItems([]);
    token.current = null;
  };

  const lookup = (text: string, caret: number, retried = false) => {
    const tok = tokenAt(text, caret);
    token.current = tok;
    const mine = ++seq.current;
    if (!tok.query) return setItems([]);
    const exclude = [...emailsIn(text.slice(0, tok.start) + text.slice(tok.end)), ...others.flatMap(emailsIn)];
    // shown at once (the same frame), the backend's answer follows and replaces it: a first letter from the people
    // prefetched per initial, a longer word by narrowing what is shown
    const excluded = new Set(exclude);
    const pool = recipientInitials(accountId)?.[fold(tok.query)[0] ?? ""] ?? [];
    const narrowed = narrow(items, pool, query, tok.query).filter((a) => !excluded.has(a.email.toLowerCase())).slice(0, 6);
    // nothing shown matches what is typed now: the list goes until the answer comes (old suggestions mustn't be acceptable)
    setQuery(tok.query);
    setItems(narrowed);
    setActive(0);
    void suggestRecipients({ query: tok.query, exclude, accountId }).then((r) => {
      if (mine !== seq.current || document.activeElement !== inputRef.current) return;
      // the index is being built the first time: ask again shortly
      if (!r.ready && !retried) {
        setTimeout(() => {
          const el = inputRef.current;
          if (mine === seq.current && el && document.activeElement === el) lookup(el.value, el.selectionStart ?? el.value.length, true);
        }, 400);
        return;
      }
      setQuery(tok.query);
      setItems(r.items);
      setActive(0);
    });
  };

  const accept = (a: Address) => {
    const el = inputRef.current;
    const tok = token.current ?? (el ? tokenAt(value, el.selectionStart ?? value.length) : null);
    // only a suggestion for what is typed now
    if (!tok || fold(tok.query) !== fold(query)) return close();
    const next = acceptAt(value, tok, a);
    caretAfter.current = next.caret;
    close();
    onChange(next.text);
  };

  // the caret after an accepted or pasted recipient, once the new value is in the field
  useLayoutEffect(() => {
    const c = caretAfter.current;
    if (c === null || !inputRef.current) return;
    caretAfter.current = null;
    inputRef.current.setSelectionRange(c, c);
  }, [value]);

  // the list follows the field (the reader scrolls, the window resizes) while it is open
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = inputRef.current;
      const row = el?.closest<HTMLElement>("[data-recipient-row]") ?? el;
      if (!el || !row) return;
      const r = row.getBoundingClientRect();
      const left = el.getBoundingClientRect().left - 8;
      setRect({ top: r.bottom + 4, left, width: Math.min(440, Math.max(260, r.right - left - 8)) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => () => void seq.current++, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // the IME's own keys (confirming a composition) aren't ours
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const own = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (!open) {
      // a lookup still in flight must not open the list after the user moved on (Enter, Tab, Esc, the caret)
      if (!["Shift", "Backspace", "Delete"].includes(e.key) && e.key.length > 1) close();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown") {
      own();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      own();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
      // Enter never sends from here while the list is open
      own();
      accept(items[active]!);
    } else if (e.key === "Escape") {
      // closes the list; the next Esc is the draft's
      own();
      close();
    } else if (e.key === "," || e.key === ";") {
      const typed = token.current?.query ?? "";
      if (/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(typed)) return;
      own();
      accept(items[active]!);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") close();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const list = pastedAddresses(e.clipboardData.getData("text/plain"));
    if (!list) return;
    e.preventDefault();
    const el = e.currentTarget;
    const next = pasteInto(value, el.selectionStart ?? value.length, el.selectionEnd ?? value.length, list, others);
    caretAfter.current = next.caret;
    close();
    onChange(next.text);
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <>
      <input
        ref={inputRef}
        id={id}
        data-testid={testId}
        className={className}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        // the list exists only while it shows (no hidden popup lingering in the page, in a stale language)
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        onFocus={() => {
          warmAutocomplete();
          prefetchRecipientInitials(accountId);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          lookup(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={close}
        onMouseDown={() => open && close()}
      />
      {open &&
        rect &&
        createPortal(
        <div
          id={listId}
          role="listbox"
          aria-label={t("compose.suggest.list")}
          data-testid="recipient-suggestions"
          // focus stays in the field: a click must not blur it
          onMouseDown={(e) => e.preventDefault()}
          style={{ top: rect.top, left: rect.left, width: rect.width }}
          className="fixed z-50 flex flex-col rounded-xl bg-popover p-1 text-sm text-popover-foreground shadow-popover outline-hidden animate-in fade-in-0 duration-base"
        >
          {items.map((a, i) => (
            <div
              key={a.email}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              data-testid="recipient-suggestion"
              data-active={i === active || undefined}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => accept(a)}
              className="flex h-11 cursor-default items-center gap-2.5 rounded-md px-2 data-active:bg-accent data-active:text-accent-foreground"
            >
              <SenderAvatar name={a.name} email={a.email} className="size-[26px] text-2xs" />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate">{a.name ? <Highlighted text={a.name} query={query} /> : <Highlighted text={a.email} query={query} />}</span>
                {a.name && (
                  <span className="truncate text-xs text-muted-foreground">
                    <Highlighted text={a.email} query={query} />
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Suggestions for `query` from what the client already has: what is shown
 * (when the query extends what it was shown for), then the people prefetched
 * for its first letter, keeping those where every word typed starts a word of
 * the name or address. The backend's answer replaces them a frame later.
 */
function narrow(items: readonly Address[], pool: readonly Address[], shownFor: string, query: string): Address[] {
  const q = fold(query);
  const terms = q.split(/[\s,;<>"()'.+_@-]+/).filter(Boolean);
  if (!terms.length) return [];
  const extends_ = !!shownFor && q.startsWith(fold(shownFor)) && q.length > fold(shownFor).length;
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of [...(extends_ ? items : []), ...pool]) {
    if (seen.has(a.email)) continue;
    seen.add(a.email);
    const words = fold(`${a.name} ${a.email}`).split(/[^\p{L}\p{N}]+/u);
    if (terms.every((t) => words.some((w) => w.startsWith(t)))) out.push(a);
  }
  return out;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query, fold).map((r, i) =>
        r.match ? (
          <span key={i} className="font-semibold" data-match>
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}
