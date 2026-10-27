import type { Address } from "@terno/core";
import { t } from "@terno/i18n";
import { fold } from "@terno/store/fold";
import { cn } from "@terno/ui/lib/utils";
import { CircleAlert, X } from "lucide-react";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { prefetchRecipientInitials, recipientInitials, suggestRecipients, warmAutocomplete } from "~/lib/autocomplete";
import { chipLabel, chipName, chipNoReply, commit, derive, edit, insert, remove, SELECT_INVALID, serialize, summaryNames, typedAddresses, type Chip, type FieldState } from "~/lib/recipient-field";
import { emailsIn, highlight, pastedAddresses, tokenAt, type TypedToken } from "~/lib/recipients";
import { renderProbe } from "~/lib/render-probe";
import { formatAddressList } from "@terno/core";
import { SenderAvatar } from "./sender-avatar";

/** Unfocused, a field with more chips than this shows the first two and "and N more" (Apple Mail's summary). */
const COLLAPSE_OVER = 3;
const UNDO_LIMIT = 100;

/** A copy that needs no clipboard permission: the copy event of a synchronous command. */
function copyText(text: string): void {
  const on = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", on);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", on);
  }
}

const mod = (e: React.KeyboardEvent) => e.metaKey || e.ctrlKey;

/**
 * A recipient field (plans 18 and 26): committed recipients as chips, a text
 * input after them for what is being typed, with suggestions (a combobox:
 * the list is portaled under the field, focus never leaves the field).
 *
 * - `,` `;` Enter, Tab, a space after a complete address, blur and a pasted
 *   list commit chips; ↑/↓ Enter Tab Esc work the suggestions as before.
 * - Backspace at the start selects the chip before (a second press removes
 *   it; a held Backspace never does), ← → Home End move among chips, ⌘A
 *   selects them all, ⌘C/⌘X copy them as an address list, Enter or a double
 *   click edits one, Delete/Backspace remove the selection, ⌘Z/⇧⌘Z undo
 *   and redo every change here (removals, edits, commits, typing).
 * - The field's text stays the draft's model (`value`): chips are read from
 *   it and written back, so drafts and conversions are unchanged.
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
  label,
}: {
  id: string;
  testId: string;
  value: string;
  /** `authored`: the addresses the user put in with this change (no longer Terno's auto ones) */
  onChange: (value: string, authored: string[]) => void;
  accountId: number;
  /** the draft's other recipient fields (their addresses aren't suggested again) */
  others: readonly string[];
  className?: string;
  placeholder?: string;
  /** the field's name ("To"), for the chips' list */
  label: string;
}) {
  const listId = useId();
  const descId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [field, setField] = useState<FieldState>(() => derive(value, false));
  const emitted = useRef(value);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const history = useRef<{ undo: FieldState[]; redo: FieldState[]; typing: boolean }>({ undo: [], redo: [], typing: false });
  const [announce, setAnnounce] = useState("");
  const [items, setItems] = useState<Address[]>([]);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const seq = useRef(0);
  const token = useRef<TypedToken | null>(null);
  const caretAfter = useRef<number | null>(null);
  const open = items.length > 0;
  const ids = useMemo(() => ({ invalid: `${descId}-invalid`, noReply: `${descId}-noreply`, hint: `${descId}-hint` }), [descId]);

  // a change from elsewhere (a draft loaded, a mode converted): read it again; this field's history starts over
  useLayoutEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    seq.current++;
    setItems([]);
    token.current = null;
    setField(derive(value, rootRef.current?.contains(document.activeElement) ?? false));
    setSelected(new Set());
    history.current = { undo: [], redo: [], typing: false };
  }, [value]);

  /** every address in the draft's fields: never suggested again (all of them, past what a request carries) */
  const taken = () => new Set([...field.chips.map((c) => c.address.email.toLowerCase()), ...others.flatMap(emailsIn)]);

  const emit = (next: FieldState, added: readonly Address[] = []) => {
    const v = serialize(next);
    if (v === emitted.current && added.length === 0) return;
    emitted.current = v;
    onChange(v, added.map((a) => a.email.toLowerCase()));
  };

  /** A change to the field: one undo step (typing: one per run, a run ends at a space or any other change). */
  const apply = (next: FieldState, o: { added?: readonly Address[]; typing?: boolean } = {}) => {
    const h = history.current;
    if (!o.typing || !h.typing) {
      h.undo.push(field);
      if (h.undo.length > UNDO_LIMIT) h.undo.shift();
    }
    h.redo = [];
    h.typing = !!o.typing && !/\s$/.test(next.text);
    setField(next);
    emit(next, o.added);
  };

  const step = (from: "undo" | "redo") => {
    const h = history.current;
    const prev = h[from].pop();
    if (!prev) return;
    h[from === "undo" ? "redo" : "undo"].push(field);
    h.typing = false;
    const back = prev.chips.length - field.chips.length;
    if (back > 0) setAnnounce(t("compose.recipients.restored", { count: back }));
    else if (back < 0) {
      const kept = new Set(prev.chips.map((c) => c.key));
      const gone = field.chips.find((c) => !kept.has(c.key));
      setAnnounce(t("compose.recipients.removed", { count: -back, name: gone ? chipLabel(gone) : "" }));
    }
    // suggestions for the text that was there are gone with it, answers in flight too (Codex code review 6)
    close();
    setField(prev);
    setSelected(new Set());
    emit(prev);
    inputRef.current?.focus();
    caretAfter.current = prev.text.length;
  };

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
    const excluded = taken();
    const exclude = [...excluded];
    // shown at once (the same frame), the backend's answer follows and replaces it: a first letter from the people
    // prefetched per initial, a longer word by narrowing what is shown
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
      // what a request couldn't carry (more than 600 in the draft) is left out here (Codex review 10)
      setItems(r.items.filter((a) => !excluded.has(a.email.toLowerCase())));
      setActive(0);
    });
  };

  const accept = (a: Address) => {
    const el = inputRef.current;
    const tok = token.current ?? (el ? tokenAt(field.text, el.selectionStart ?? field.text.length) : null);
    // only a suggestion for what is typed now
    if (!tok || fold(tok.query) !== fold(query)) return close();
    const before = field.text.slice(0, tok.start).trim();
    const after = field.text.slice(tok.end).replace(/^\s*[,;]?\s*/, "").trim();
    close();
    // what else the input held (rare: a paste without separators) is committed around it
    const base = before ? commit({ ...field, text: before }).state : field;
    const { state, added } = insert({ ...base, text: "" }, [a]);
    apply({ ...state, text: after }, { added });
    caretAfter.current = after.length;
  };

  const commitTyped = () => {
    if (!field.text.trim()) return false;
    const { state, added } = commit(field);
    if (!added.length && field.text.trim()) setAnnounce(t("compose.recipients.already", { name: field.text.trim() }));
    else if (added.length) setAnnounce(t("compose.recipients.added", { count: added.length, name: added[0]!.name || added[0]!.email }));
    apply(state, { added });
    return true;
  };

  /** Focus a chip (selecting it alone, or extending from the anchor with Shift). */
  const focusChip = (key: number, extend = false) => {
    const keys = field.chips.map((c) => c.key);
    if (extend && anchor.current !== null && keys.includes(anchor.current)) {
      const from = keys.indexOf(anchor.current);
      const to = keys.indexOf(key);
      setSelected(new Set(keys.slice(Math.min(from, to), Math.max(from, to) + 1)));
    } else {
      anchor.current = key;
      setSelected(new Set([key]));
    }
    rootRef.current?.querySelector<HTMLElement>(`[data-chip-key="${key}"]`)?.focus();
  };

  const focusInput = (caret?: number) => {
    setSelected(new Set());
    inputRef.current?.focus();
    if (caret !== undefined) inputRef.current?.setSelectionRange(caret, caret);
  };

  const removeChips = (keys: ReadonlySet<number>) => {
    const gone = field.chips.filter((c) => keys.has(c.key));
    if (!gone.length) return;
    setAnnounce(t("compose.recipients.removed", { count: gone.length, name: chipLabel(gone[0]!) }));
    apply(remove(field, keys));
    focusInput(0);
  };

  const editChip = (key: number) => {
    const next = edit(field, key);
    apply(next);
    focusInput();
    caretAfter.current = next.text.length;
  };

  // the caret after an accepted or pasted recipient, an edit or an undo, once the new text is in the field
  useLayoutEffect(() => {
    const c = caretAfter.current;
    if (c === null || !inputRef.current) return;
    caretAfter.current = null;
    inputRef.current.setSelectionRange(c, c);
  }, [field]);

  // Send asks for the first invalid chip
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const show = () => {
      const bad = root.querySelector<HTMLElement>("[data-testid=recipient-chip][data-invalid]");
      const key = Number(bad?.dataset.chipKey);
      if (bad && key) {
        anchor.current = key;
        setSelected(new Set([key]));
        bad.focus();
      } else inputRef.current?.focus();
    };
    root.addEventListener(SELECT_INVALID, show);
    return () => root.removeEventListener(SELECT_INVALID, show);
  });

  // the list follows the field (the reader scrolls, the window resizes) while it is open
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = inputRef.current;
      const row = el?.closest<HTMLElement>("[data-recipient-row]") ?? el;
      if (!el || !row) return;
      const r = row.getBoundingClientRect();
      const left = Math.min(el.getBoundingClientRect().left - 8, r.right - 268);
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

  // the Edit menu's Undo / Redo (Electron's role items) arrive as native beforeinput events (React's onBeforeInput
  // is a text-input polyfill that never sees them): this field's own history
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const on = (e: InputEvent) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      e.preventDefault();
      step(e.inputType === "historyUndo" ? "undo" : "redo");
    };
    el.addEventListener("beforeinput", on);
    return () => el.removeEventListener("beforeinput", on);
  });

  const undoKey = (e: React.KeyboardEvent): "undo" | "redo" | null => {
    if (!mod(e) || e.altKey) return null;
    const k = e.key.toLowerCase();
    if (k === "z") return e.shiftKey ? "redo" : "undo";
    if (k === "y" && e.ctrlKey && !e.metaKey) return "redo";
    return null;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // the IME's own keys (confirming a composition) aren't ours
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const own = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    const u = undoKey(e);
    if (u) {
      own();
      return step(u);
    }
    if (open && !mod(e) && !e.altKey) {
      if (e.key === "ArrowDown") {
        own();
        return setActive((i) => (i + 1) % items.length);
      }
      if (e.key === "ArrowUp") {
        own();
        return setActive((i) => (i - 1 + items.length) % items.length);
      }
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
        // Enter never sends from here while the list is open
        own();
        return accept(items[active]!);
      }
      if (e.key === "Escape") {
        // closes the list; the next Esc is the draft's
        own();
        return close();
      }
      if (e.key === "," || e.key === ";") {
        const typed = token.current?.query ?? "";
        if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(typed)) {
          own();
          return accept(items[active]!);
        }
      }
    }
    // a lookup still in flight must not open the list after the user moved on (Enter, Tab, Esc, the caret)
    if (!open && !["Shift", "Backspace", "Delete"].includes(e.key) && e.key.length > 1) close();
    if (mod(e) && e.key.toLowerCase() === "a" && !e.shiftKey && !el.value && field.chips.length) {
      own();
      const keys = field.chips.map((c) => c.key);
      anchor.current = keys[0]!;
      setSelected(new Set(keys));
      rootRef.current?.querySelector<HTMLElement>(`[data-chip-key="${keys[keys.length - 1]}"]`)?.focus();
      return;
    }
    if (mod(e) || e.altKey) return;
    const unclosed = (() => {
      const tail = el.value;
      const quotes = (tail.match(/(?<!\\)"/g) ?? []).length;
      return quotes % 2 === 1 || tail.lastIndexOf("<") > tail.lastIndexOf(">");
    })();
    if ((e.key === "," || e.key === ";") && !unclosed) {
      own();
      close();
      commitTyped();
    } else if (e.key === "Enter") {
      // a bare Enter in a recipient field never submits (sends) the draft: it commits what was typed
      own();
      commitTyped();
    } else if (e.key === "Tab" && !e.shiftKey) {
      // committed, and focus moves on as usual
      commitTyped();
    } else if (e.key === " " && atEnd && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(el.value.trim())) {
      own();
      close();
      commitTyped();
    } else if (e.key === "Backspace" && atStart && field.at > 0 && !e.repeat) {
      // the first press selects the chip before; the second removes it (a held key never reaches the chips)
      own();
      close();
      focusChip(field.chips[field.at - 1]!.key);
    } else if (e.key === "ArrowLeft" && atStart && field.at > 0) {
      own();
      close();
      focusChip(field.chips[field.at - 1]!.key, e.shiftKey);
    } else if ((e.key === "ArrowRight" || e.key === "Delete") && atEnd && field.at < field.chips.length && !e.repeat) {
      own();
      focusChip(field.chips[field.at]!.key);
    }
  };

  /** Keys on a chip (one handler for all of them: the chips stay memoized). */
  const onChipKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const key = Number((e.target as HTMLElement).closest<HTMLElement>("[data-chip-key]")?.dataset.chipKey);
    if (!key) return;
    const keys = field.chips.map((c) => c.key);
    const i = keys.indexOf(key);
    const own = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const sel = selected.size ? selected : new Set([key]);
    const u = undoKey(e);
    if (u) {
      own();
      return step(u);
    }
    if (mod(e) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "a") {
        own();
        anchor.current = keys[0]!;
        return setSelected(new Set(keys));
      }
      if (k === "c" || k === "x") {
        own();
        copyText(formatAddressList(field.chips.filter((c) => sel.has(c.key)).map((c) => c.address)));
        if (k === "x") removeChips(sel);
        return;
      }
      // ⌘V and the rest: the input's (a paste lands there)
      if (k === "v") focusInput(inputRef.current?.value.length ?? 0);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      own();
      if (!e.repeat) removeChips(sel);
    } else if (e.key === "ArrowLeft") {
      own();
      if (i > 0) focusChip(keys[i - 1]!, e.shiftKey);
    } else if (e.key === "ArrowRight") {
      own();
      if (i < keys.length - 1) focusChip(keys[i + 1]!, e.shiftKey);
      else if (!e.shiftKey) focusInput(0);
    } else if (e.key === "Home") {
      own();
      focusChip(keys[0]!, e.shiftKey);
    } else if (e.key === "End") {
      own();
      focusInput(inputRef.current?.value.length ?? 0);
    } else if (e.key === "Enter" || e.key === "F2") {
      own();
      editChip(key);
    } else if (e.key === "Escape") {
      // back to the input; the next Esc is the draft's
      own();
      focusInput();
    } else if (e.key.length === 1 && !e.altKey) {
      // typing goes to the input (the browser types into what has focus after keydown); the chip stays
      focusInput(inputRef.current?.value.length ?? 0);
    }
  };

  const onChipMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const el = target.closest<HTMLElement>("[data-chip-key]");
    if (!el) return;
    e.preventDefault();
    const key = Number(el.dataset.chipKey);
    if (target.closest("[data-chip-remove]")) return removeChips(new Set([key]));
    if (e.detail >= 2) return editChip(key);
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      anchor.current = key;
      setSelected(next);
      el.focus();
      return;
    }
    focusChip(key, e.shiftKey);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text/plain");
    if (!pastedAddresses(pasted)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const text = el.value.slice(0, el.selectionStart ?? el.value.length) + pasted + el.value.slice(el.selectionEnd ?? el.value.length);
    close();
    // duplicates: what this field and the other fields already have (plan 18); entries that aren't addresses stay
    const { state, added } = insert({ ...field, text: "" }, typedAddresses(text), others.flatMap(emailsIn));
    setAnnounce(t("compose.recipients.added", { count: added.length, name: added[0]?.name || added[0]?.email || "" }));
    apply({ ...state, at: state.chips.length }, { added });
  };

  const collapsed = !focused && field.chips.length > COLLAPSE_OVER && !field.text;
  const shown = collapsed ? field.chips.slice(0, 2) : field.chips;
  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div
      ref={rootRef}
      data-recipient-field={testId}
      data-testid={`${testId}-field`}
      data-collapsed={collapsed || undefined}
      className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 py-1"
      onMouseDown={(e) => {
        // the field's empty space puts the caret at the end
        if (e.target === e.currentTarget) {
          e.preventDefault();
          focusInput(inputRef.current?.value.length ?? 0);
        }
      }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
        setFocused(false);
        setSelected(new Set());
        close();
        // what was typed becomes a chip; the input goes back after the chips
        if (field.text.trim()) commitTyped();
        else if (field.at !== field.chips.length) setField({ ...field, at: field.chips.length });
      }}
    >
      {shown.length > 0 && (
        <div role="listbox" aria-multiselectable="true" aria-label={t("compose.recipients.list", { field: label })} aria-orientation="horizontal" className="contents" onKeyDown={onChipKeyDown} onMouseDown={onChipMouseDown} data-testid="recipient-chips">
          {shown.map((c) => (
            <RecipientChip key={c.key} chip={c} selected={selected.has(c.key)} ids={ids} />
          ))}
        </div>
      )}
      {collapsed && (
        <button
          type="button"
          data-testid="recipient-more"
          // the name is what it says ("and 14 more"); what it does is its description
          aria-describedby={`${descId}-all`}
          onMouseDown={(e) => {
            e.preventDefault();
            focusInput(0);
          }}
          onClick={() => focusInput(0)}
          // Tab lands here: focus moves on to the input before the expanded field takes this button away (code review 7)
          onFocus={() => focusInput(0)}
          className="h-[22px] rounded-md px-1 text-sm text-muted-foreground hover:text-foreground"
        >
          {t("compose.recipients.more", { count: field.chips.length - shown.length })}
        </button>
      )}
      {collapsed && (
        <span id={`${descId}-all`} hidden>
          {t("compose.recipients.showAll", { count: field.chips.length })}
        </span>
      )}
      <input
        ref={inputRef}
        id={id}
        data-testid={testId}
        className={cn(className, "h-7 min-w-24 basis-24")}
        value={field.text}
        placeholder={field.chips.length ? undefined : placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        // the list exists only while it shows (no hidden popup lingering in the page, in a stale language)
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        onFocus={() => {
          setSelected(new Set());
          warmAutocomplete();
          prefetchRecipientInitials(accountId);
        }}
        onChange={(e) => {
          apply({ ...field, text: e.target.value }, { typing: true });
          lookup(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onMouseDown={() => open && close()}
      />
      <span id={ids.invalid} hidden>
        {t("compose.recipients.invalid")}
      </span>
      <span id={ids.noReply} hidden>
        {t("compose.recipients.noReply")}
      </span>
      <span id={ids.hint} hidden>
        {t("compose.recipients.removeHint")}
      </span>
      <span aria-live="polite" className="sr-only" data-testid="recipient-announce">
        {announce}
      </span>
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
    </div>
  );
}

/**
 * One recipient: its name (or address), the full address in its accessible
 * name and tooltip; quiet at rest, the accent when selected; an address that
 * isn't one in the destructive ink, dotted. Memoized: typing in the field
 * renders none of them (plan 34's render gate).
 */
const RecipientChip = memo(function RecipientChip({ chip: c, selected, ids }: { chip: Chip; selected: boolean; ids: { invalid: string; noReply: string; hint: string } }) {
  renderProbe("RecipientChip");
  const noReply = chipNoReply(c);
  const described = [!c.valid && ids.invalid, noReply && ids.noReply, ids.hint].filter(Boolean).join(" ");
  const title = [chipName(c), !c.valid && t("compose.recipients.invalid"), noReply && t("compose.recipients.noReply")].filter(Boolean).join(" · ");
  return (
    <span
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={chipName(c)}
      aria-describedby={described}
      aria-invalid={!c.valid || undefined}
      title={title}
      data-chip-key={c.key}
      data-testid="recipient-chip"
      data-email={c.address.email}
      data-invalid={!c.valid || undefined}
      className={cn(
        "group/chip inline-flex h-[22px] max-w-64 min-w-0 cursor-default items-center gap-0.5 rounded-md bg-muted px-1.5 text-sm text-foreground outline-none select-none animate-in fade-in-0 duration-base hover:bg-accent hover:text-accent-foreground",
        "aria-selected:bg-primary aria-selected:text-primary-foreground",
        // an invalid one keeps its fill (its mark is drawn for the fill: destructive on muted, CONTRAST_PAIRS)
        !c.valid && "hover:bg-muted hover:text-foreground",
      )}
    >
      {!c.valid && <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-destructive group-aria-selected/chip:text-primary-foreground" />}
      <span className={cn("truncate", !c.valid && "underline decoration-destructive decoration-dotted decoration-2 underline-offset-[3px] group-aria-selected/chip:decoration-primary-foreground")}>{chipLabel(c)}</span>
      {/* on the selected chip only: no space held at rest (the chips stay balanced), nothing shifts under a moving pointer */}
      {selected && (
        <span aria-hidden="true" data-chip-remove className="-mr-0.5 grid size-4 shrink-0 place-items-center rounded-sm">
          <X className="size-3" />
        </span>
      )}
    </span>
  );
});

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

/** "Ana, Bob and 12 more" for a field's text (the collapsed draft's line). */
export function recipientSummary(text: string, shown = 2): string {
  const chips = derive(text, false).chips;
  const names = summaryNames(chips, shown).join(", ");
  return chips.length > shown ? t("compose.recipients.summary", { count: chips.length - shown, names }) : names;
}
