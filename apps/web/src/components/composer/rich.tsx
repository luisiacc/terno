import "./rich.css";
import { FONT_CSS, parseHtml, HIGHLIGHT_DARK, HIGHLIGHT_HEX, HIGHLIGHT_INK, HIGHLIGHT_INK_DARK, HIGHLIGHTS, normalizeHref, TEXT_COLORS, TEXT_DARK, TEXT_HEX, schema } from "@terno/richtext";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@terno/ui/components/toolbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import {
  ALargeSmall,
  Baseline,
  Bold,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Pencil,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TextQuote,
  Underline,
  Undo2,
  Unlink,
} from "lucide-react";
import { TextSelection, type EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { attachBody, bodyCheckpoint, draftEditsHeld, retainedBodyState, useDrafts, validBodyCheckpoint, type BodyCheckpoint } from "~/lib/drafts";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";
import { suggestText } from "~/lib/autocomplete";
import { setApp, useApp } from "~/state/app";
import { parseAddressList } from "@terno/core";
import { dismissGhost, withoutGhost, type GhostHooks } from "./ghost";
import { exposeForTests } from "~/lib/render-probe";
import { openLink } from "../mail-body";
import { takeEarly, takeStandInFocus } from "./lazy";
import { EMPTY_FORMAT, registerController, useController, useFormatState, type Align, type ComposerController, type FormatCommand, type FormatState } from "./controller";
import { appendTyped, applyLink, COMMANDS, createEditor, docOf, formatState, isEmpty, keepState, keptState, linkAt, newState, removeLink, sameFormat, serialize, setAlign, setMark } from "./editor";

/**
 * The rich composer (plan 16), lazy: the editable body of a draft, its format
 * bar, the link popover and the link bubble. The draft module owns saving;
 * this owns the document while it is on screen.
 */

// ── the palette as the editor shows it (the mail's own values in light themes, light inks and deep washes in dark ones)

let paletteStyled = false;
function stylePalette() {
  if (paletteStyled) return;
  paletteStyled = true;
  const rules: string[] = [];
  for (const c of TEXT_COLORS) {
    rules.push(`.rt-body [data-rt-color="${c}"]{color:${TEXT_HEX[c]}!important}`, `.dark .rt-body [data-rt-color="${c}"]{color:${TEXT_DARK[c]}!important}`);
  }
  for (const h of HIGHLIGHTS) {
    rules.push(
      // the ink too: the mark's own inline ink is the mail's (dark), which a dark theme's wash can't carry
      `.rt-body [data-rt-highlight="${h}"]{background-color:${HIGHLIGHT_HEX[h]}!important;color:${HIGHLIGHT_INK}!important}`,
      `.dark .rt-body [data-rt-highlight="${h}"]{background-color:${HIGHLIGHT_DARK[h]}!important;color:${HIGHLIGHT_INK_DARK}!important}`,
    );
  }
  const style = document.createElement("style");
  style.dataset.rtPalette = "";
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
}

/** A swatch as the toolbar shows it: the editor's value for the current mode. */
const swatchText = (c: string, dark: boolean) => (dark ? TEXT_DARK : TEXT_HEX)[c as keyof typeof TEXT_HEX];
const swatchWash = (h: string, dark: boolean) => (dark ? HIGHLIGHT_DARK : HIGHLIGHT_HEX)[h as keyof typeof HIGHLIGHT_HEX];
const isDark = () => document.documentElement.classList.contains("dark");

// ── the body

/** Test builds: timings by name (window.__composer), for the perf suite. */
function probe(name: string, value: number) {
  const w = window as unknown as { __composer?: Record<string, number[]> };
  ((w.__composer ??= {})[name] ??= []).push(value);
}

let readFault = false, failedReads = 0;
if (import.meta.env.VITE_RENDER_PROBE) exposeForTests({
  composerReadFault: (enabled?: boolean) => {
    if (enabled !== undefined) { readFault = enabled; if (enabled) failedReads = 0; }
    return failedReads;
  },
});
function readBody(doc: PMNode) {
  if (import.meta.env.VITE_RENDER_PROBE && readFault) { failedReads++; throw new Error("test: composer body read failed"); }
  return serialize(doc);
}

/** Test builds: the focused editor's document, and the parser, so a round trip can compare what was written with what arrived. */
const views = new Set<EditorView>();
exposeForTests({
  composerDoc: () => [...views].find((v) => v.hasFocus())?.state.doc.toJSON() ?? null,
  // the perf suite: the caret at the end of a top-level line (or `offset` into it), in the editor's own state
  setComposerCaret: (index: number, offset?: number) => {
    const view = [...views].at(-1);
    if (!view) return false;
    const doc = view.state.doc;
    const at = index < 0 ? doc.childCount + index : index;
    let pos = 0;
    for (let i = 0; i < at; i++) pos += doc.child(i).nodeSize;
    const block = doc.child(at);
    const inside = pos + 1 + Math.min(offset ?? block.content.size, block.content.size);
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, inside)).scrollIntoView());
    return true;
  },
  // the perf suite's paired measurement: suggestions on and off without a settings round trip
  setComposeSuggestions: (on: boolean) => {
    const settings = useApp.getState().settings;
    if (settings) setApp({ settings: { ...settings, composeSuggestions: on } });
  },
  parseMailHtml: (html: string) => parseHtml(html).toJSON(),
});

interface LinkDraft {
  from: number;
  to: number;
  text: string;
  href: string;
  /** the text field shows when the range is text within one line */
  textEditable: boolean;
  editing: boolean;
}

export function RichBody({ draftKey, placeholder, className, checkpoint, focusOwner }: { draftKey: string; placeholder: string; className?: string; checkpoint?: BodyCheckpoint; focusOwner?: object }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const version = useDrafts((s) => s.drafts[draftKey]?.bodyVersion ?? 0);
  const sending = useDrafts((s) => s.held || (s.drafts[draftKey]?.sending ?? false));
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const versionRef = useRef(version);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [bubble, setBubble] = useState<{ from: number; to: number; href: string; top: number; left: number } | null>(null);
  const bodyRef = useRef<ReturnType<typeof attachBody> | null>(null);
  const adoptedRef = useRef<{ original: BodyCheckpoint; replay?: BodyCheckpoint } | null>(null);
  const replayFocusRef = useRef<string | null>(null);
  const openLinkRef = useRef<() => void>(() => {});
  /** recomputes the toolbar's state (a send starting or ending changes what it may do) */
  const refreshRef = useRef<() => void>(() => {});
  /** the screen-reader announcement of a new suggestion (written directly: no re-render) */
  const announceRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    stylePalette();
    const mount = mountRef.current!;
    const d = useDrafts.getState().drafts[draftKey];
    if (!d) return;
    versionRef.current = d.bodyVersion;
    // keys typed into the stand-in while this chunk loaded: the document is what the draft had then, plus them
    const replay = checkpoint && adoptedRef.current?.original === checkpoint ? adoptedRef.current.replay : undefined;
    const lease = replay ?? checkpoint;
    if (checkpoint && (!lease || lease.key !== draftKey || !validBodyCheckpoint(lease) || (useDraftRecovery.getState().checkpoint !== checkpoint && (!replay || useDraftRecovery.getState().checkpoint !== undefined)) || !useDraftRecovery.getState().open)) throw new Error("Draft checkpoint is no longer available");
    const early = checkpoint ? null : takeEarly(draftKey, focusOwner);
    const state = lease ? lease.retained.state as EditorState : early ? newState(appendTyped(docOf(early.base.html, early.base.text), early.text)) : (retainedBodyState<EditorState>(draftKey, d.bodyVersion) ?? keptState(draftKey, d.bodyVersion) ?? newState(docOf(d.bodyHtml, d.bodyText)));
    let format: FormatState = EMPTY_FORMAT;
    const listeners = new Set<() => void>();
    let frame = 0;
    let focusedOnce = false;
    // the toolbar's state, once per frame at most (a long selection is walked once, not per transaction)
    const publish = () => {
      frame = 0;
      const view = viewRef.current;
      if (!view) return;
      const t0 = performance.now();
      const next = formatState(view.state, !sendingRef.current && !draftEditsHeld());
      if (import.meta.env.VITE_RENDER_PROBE) probe("format", performance.now() - t0);
      if (!sameFormat(next, format)) {
        format = next;
        for (const l of listeners) l();
      }
      updateBubble(view);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(publish);
    };
    // the placeholder, and (thousands of lines) skipping layout for lines off screen
    const emptyClass = (view: EditorView) => {
      view.dom.classList.toggle("is-empty", serializeEmpty(view.state));
      view.dom.classList.toggle("rt-huge", view.state.doc.childCount > HUGE_BLOCKS);
    };
    const editor = createEditor(mount, {
      state,
      editable: () => !sendingRef.current && !draftEditsHeld(),
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("compose.body"),
        "aria-placeholder": placeholder,
        "data-placeholder": placeholder,
        "data-testid": "compose-body",
        spellcheck: "true",
        // a huge draft skips its lines off screen from the first style pass on: anything that reads style or layout
        // before emptyClass() runs would otherwise style every line (typing then cost twice as much, plan 16)
        class: cn("rt-body type-body", className, state.doc.childCount > HUGE_BLOCKS && "rt-huge"),
      },
      hooks: {
        onChange: () => {
          if (import.meta.env.VITE_RENDER_PROBE) probe("tx", performance.now());
          bodyRef.current?.changed();
          if (viewRef.current) emptyClass(viewRef.current);
        },
        onUpdate: schedule,
        onLink: () => openLinkRef.current(),
        openLink,
        ghost: ghostHooks(draftKey, () => !sendingRef.current && !draftEditsHeld(), (text) => {
          const el = announceRef.current;
          if (el) el.textContent = t("compose.suggest.announce", { text: text.trim() });
        }),
      },
    });
    const view = editor.view;
    let unregister: (() => void) | undefined;
    try {
      viewRef.current = view;
      views.add(view);
      emptyClass(view);
      const focus = (where: "end" | "keep" = "keep") => {
        if (where === "end" && !focusedOnce) view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
        focusedOnce = true;
        view.focus();
      };
      const controller: ComposerController = {
        run: (command: FormatCommand) => {
          // nothing changes under a send in flight (the draft is sending what is there now)
          if (sendingRef.current || draftEditsHeld()) return;
          COMMANDS[command](view.state, view.dispatch, view);
          view.focus();
        },
        setFont: (v) => run(setMark(schema.marks.font, v)),
        setSize: (v) => run(setMark(schema.marks.size, v)),
        setColor: (v, f) => run(setMark(schema.marks.color, v), f),
        setHighlight: (v, f) => run(setMark(schema.marks.highlight, v), f),
        setAlign: (v: Align) => run(setAlign(v)),
        openLink: () => openLinkRef.current(),
        focus,
        dom: view.dom as HTMLElement,
        getState: () => format,
        subscribe: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      };
      function run(cmd: (s: EditorState, d?: EditorView["dispatch"]) => boolean, focusAfter = true) {
        if (sendingRef.current || draftEditsHeld()) return;
        cmd(view.state, view.dispatch);
        if (focusAfter) view.focus();
      }
      format = formatState(view.state, !sendingRef.current && !draftEditsHeld());
      refreshRef.current = schedule;
      // the stand-in had focus (typed into or not): the editor that replaces it takes it
      const standInFocused = takeStandInFocus(draftKey, focusOwner);
      const replayFocus = replayFocusRef.current === draftKey && document.activeElement === document.body;
      replayFocusRef.current = null;
      if (replayFocus) focus("keep");
      else if (!checkpoint && (early?.focused || standInFocused) && (document.activeElement === document.body || mount.contains(document.activeElement))) focus("end");
      unregister = registerController(draftKey, controller);
      if (checkpoint && ((useDraftRecovery.getState().checkpoint !== checkpoint && (!replay || useDraftRecovery.getState().checkpoint !== undefined)) || !useDraftRecovery.getState().open)) throw new Error("Draft checkpoint is no longer available");
      bodyRef.current = attachBody(draftKey, () => {
        const t0 = performance.now();
        const out = readBody(view.state.doc);
        if (import.meta.env.VITE_RENDER_PROBE) probe("serialize", performance.now() - t0);
        return out;
      }, { checkpoint: lease });
      if (early?.text) bodyRef.current.changed();
      if (checkpoint) useDraftRecovery.setState({ checkpoint: undefined });
      return () => {
        if (frame) cancelAnimationFrame(frame);
        replayFocusRef.current = view.dom.contains(document.activeElement) ? draftKey : null;
        // a suggestion is never brought back by a remount
        const state = withoutGhost(view.state);
        keepState(draftKey, state, versionRef.current);
        bodyRef.current?.dispose({ state, version: versionRef.current, read: () => readBody(state.doc) });
        if (checkpoint) {
          const next = bodyCheckpoint(draftKey);
          adoptedRef.current = { original: checkpoint, replay: next?.retained.state === state ? next : undefined };
        }
        bodyRef.current = null;
        unregister?.();
        viewRef.current = null;
        views.delete(view);
        editor.destroy();
      };
    } catch (error) {
      if (frame) cancelAnimationFrame(frame);
      unregister?.();
      viewRef.current = null;
      views.delete(view);
      editor.destroy();
      throw error;
    }
  }, [draftKey]);

  // a body set from elsewhere (a conversion's undo, an import): the editor shows it
  useEffect(() => {
    const view = viewRef.current;
    if (!view || version === versionRef.current) return;
    versionRef.current = version;
    const d = useDrafts.getState().drafts[draftKey];
    if (!d) return;
    view.updateState(newState(docOf(d.bodyHtml, d.bodyText)));
    view.dom.classList.toggle("is-empty", serializeEmpty(view.state));
    bodyRef.current?.reset();
  }, [version, draftKey]);

  // read-only while its send is in flight (edits would be dropped)
  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !sending });
    if (sending && viewRef.current) dismissGhost(viewRef.current);
    refreshRef.current();
  }, [sending]);

  // a suggestion made for other recipients, another account, or with suggestions turned off goes
  const toText = useDrafts((s) => s.drafts[draftKey]?.toText ?? "");
  const accountId = useDrafts((s) => s.drafts[draftKey]?.accountId ?? 0);
  const suggestionsOn = useApp((s) => s.settings?.composeSuggestions !== false);
  useEffect(() => {
    if (viewRef.current) dismissGhost(viewRef.current);
  }, [toText, accountId, suggestionsOn]);

  function updateBubble(view: EditorView) {
    const wrap = wrapRef.current;
    const at = view.hasFocus() ? linkAt(view.state) : null;
    if (!at || !wrap) return setBubble((b) => (b ? null : b));
    const start = view.coordsAtPos(at.from);
    const box = wrap.getBoundingClientRect();
    const top = start.bottom - box.top + 4;
    const left = Math.max(0, Math.min(start.left - box.left, box.width - 280));
    setBubble((b) => (b && b.from === at.from && b.to === at.to && b.href === at.href && b.top === top && b.left === left ? b : { ...at, top, left }));
  }

  openLinkRef.current = () => {
    const view = viewRef.current;
    if (!view || sendingRef.current) return;
    const { state } = view;
    const existing = linkAt(state);
    const { from, to, $from, $to } = state.selection;
    const range = existing ?? { from, to };
    const sameLine = existing !== null || $from.parent === $to.parent;
    setBubble(null);
    setLink({ ...range, text: state.doc.textBetween(range.from, range.to), href: existing?.href ?? "", textEditable: sameLine, editing: existing !== null });
  };

  const closeLink = () => {
    // gone first, then focus: a popover still mounted would keep (or hand back) focus, and the next keys would miss the text
    flushSync(() => setLink(null));
    viewRef.current?.focus();
  };

  return (
    <div ref={wrapRef} className="relative">
      {/* the ghost layer's containing block (beside the editor's own element) */}
      <div ref={mountRef} className="relative" />
      <span ref={announceRef} className="sr-only" aria-live="polite" data-testid="compose-ghost-announce" />
      {link && viewRef.current && <LinkPopover view={viewRef.current} draft={link} onClose={closeLink} />}
      {bubble && !link && viewRef.current && (
        <LinkBubble
          href={bubble.href}
          top={bubble.top}
          left={bubble.left}
          onOpen={() => openLink(bubble.href)}
          onEdit={() => openLinkRef.current()}
          onRemove={() => {
            removeLink(viewRef.current!, bubble);
            viewRef.current!.focus();
          }}
        />
      )}
    </div>
  );
}

/** The draft's recipients' first names and the sender's name, for a learned greeting or sign-off. */
function ghostContext(draftKey: string): { names: string[]; me: string | undefined; key: string } | null {
  const d = useDrafts.getState().drafts[draftKey];
  if (!d) return null;
  const names = parseAddressList(d.toText)
    .map((a) => a.name.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean)
    .slice(0, 10);
  const account = useApp.getState().accounts.find((a) => a.id === d.accountId);
  const me = account?.senderName || account?.displayName || undefined;
  return { names, me, key: `${d.accountId}|${d.toText}` };
}

/** What the ghost plugin asks of the draft: whether suggestions are on, and one for the text before the caret. */
function ghostHooks(draftKey: string, editable: () => boolean, announce: (text: string) => void): GhostHooks {
  return {
    enabled: () => editable() && useApp.getState().settings?.composeSuggestions !== false,
    suggest: async (before) => {
      const asked = ghostContext(draftKey);
      if (!asked) return null;
      const text = await suggestText({ before, names: asked.names, me: asked.me });
      // the recipients or the account changed while it was asked: the answer was for another draft
      return ghostContext(draftKey)?.key === asked.key ? text : null;
    },
    announce,
  };
}

/** Past this many lines a draft is "huge": its lines off screen skip layout (a keystroke at 2 MB went from ~56 to ~7 ms). */
const HUGE_BLOCKS = 2000;

/** The placeholder shows on an empty body (one empty line): checked in O(1), never by serializing. */
const serializeEmpty = (state: EditorState): boolean => isEmpty(state.doc);

// ── links

function LinkPopover({ view, draft, onClose }: { view: EditorView; draft: LinkDraft; onClose: () => void }) {
  const id = useId();
  const [text, setText] = useState(draft.text);
  const [href, setHref] = useState(draft.href);
  const [error, setError] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  // anchored to the selection's start (its line), where the link goes
  const anchor = useRef({
    getBoundingClientRect: () => {
      const a = view.coordsAtPos(draft.from);
      const b = view.coordsAtPos(draft.to);
      const sameLine = Math.abs(a.top - b.top) < 4;
      const left = a.left;
      const right = sameLine ? Math.max(b.right, a.left + 1) : a.left + 1;
      return new DOMRect(left, a.top, right - left, a.bottom - a.top);
    },
  }).current;

  const apply = () => {
    const normalized = normalizeHref(href);
    if (!normalized) {
      setError(true);
      urlRef.current?.focus();
      return;
    }
    applyLink(view, draft, normalized, draft.textEditable ? text : undefined);
    onClose();
  };
  const keys = (e: React.KeyboardEvent) => {
    // the popover owns Enter and Escape: never the composer's send or collapse
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      apply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const field = "h-8 w-full rounded-md bg-background px-2.5 text-sm outline-none shadow-hairline placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:ring-2 aria-invalid:ring-destructive/40";

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverContent anchor={anchor} side="bottom" align="start" sideOffset={6} initialFocus={urlRef} finalFocus={false} className="w-80 gap-2.5" data-testid="link-popover" aria-labelledby={`${id}-title`} onKeyDown={keys}>
        <div id={`${id}-title`} className="text-xs font-medium text-muted-foreground">
          {draft.editing ? t("compose.link.edit") : t("compose.link.insert")}
        </div>
        {draft.textEditable && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t("compose.link.text")}</span>
            <input data-testid="link-text" className={field} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("compose.link.url")}</span>
          <input
            ref={urlRef}
            data-testid="link-url"
            className={field}
            value={href}
            placeholder={t("compose.link.urlPlaceholder")}
            onChange={(e) => {
              setHref(e.target.value);
              setError(false);
            }}
            aria-invalid={error || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
        </label>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-xs text-destructive-ink" data-testid="link-error">
            {t("compose.link.invalid")}
          </p>
        )}
        <div className="flex justify-end gap-1.5 pt-0.5">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="link-cancel">
            {t("common.cancel")}
          </Button>
          <Button type="button" size="sm" onClick={apply} disabled={!href.trim()} data-testid="link-apply">
            {t("compose.link.apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Under a link the caret is in: where it goes, open, edit, remove. In the editor's flow, so Tab reaches it. */
function LinkBubble({ href, top, left, onOpen, onEdit, onRemove }: { href: string; top: number; left: number; onOpen: () => void; onEdit: () => void; onRemove: () => void }) {
  const icon = "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none [&_svg]:size-3.5";
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div
      role="group"
      aria-label={t("compose.link.bubble", { href: href.replace(/^mailto:/, "") })}
      data-testid="link-bubble"
      style={{ top, left }}
      className="absolute z-20 flex max-w-[280px] items-center gap-0.5 rounded-lg surface-glass py-0.5 pr-0.5 pl-2 text-xs shadow-popover animate-in fade-in-0 duration-fast"
    >
      <button type="button" onMouseDown={keep} onClick={onOpen} className="min-w-0 truncate rounded-sm text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring outline-none" data-testid="link-bubble-open" title={href}>
        {href.replace(/^mailto:/, "")}
      </button>
      <span className="mx-1 h-3.5 w-(--hairline-w) shrink-0 bg-hairline" />
      <button type="button" onMouseDown={keep} onClick={onOpen} aria-label={t("compose.link.open")} className={icon}>
        <ExternalLink />
      </button>
      <button type="button" onMouseDown={keep} onClick={onEdit} aria-label={t("compose.link.edit")} className={icon} data-testid="link-bubble-edit">
        <Pencil />
      </button>
      <button type="button" onMouseDown={keep} onClick={onRemove} aria-label={t("compose.link.remove")} className={icon} data-testid="link-bubble-remove">
        <Unlink />
      </button>
    </div>
  );
}

// ── the format bar

const tool =
  "inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground data-[popup-open]:bg-foreground/[0.06] data-[popup-open]:text-foreground data-disabled:pointer-events-none data-disabled:opacity-35 [&_svg]:size-4 [&_svg]:[stroke-width:var(--icon-stroke-toolbar)]";
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function Tip({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>
        {label}
        {keys && <Shortcut keys={keys} />}
      </TooltipContent>
    </Tooltip>
  );
}

function Tool({ label, keys, pressed, disabled, onRun, testId, children }: { label: string; keys?: string; pressed?: boolean; disabled?: boolean; onRun: () => void; testId: string; children: ReactNode }) {
  return (
    <Tip label={label} keys={keys}>
      <ToolbarButton type="button" aria-label={label} aria-pressed={pressed} disabled={disabled} onMouseDown={keepFocus} onClick={onRun} data-testid={testId} className={tool}>
        {children}
      </ToolbarButton>
    </Tip>
  );
}

/** A menu of exclusive values (font, size, alignment): picks apply to the selection, focus goes back to the text. */
function ValueMenu<V extends string>({ label, name, value, items, onPick, trigger, testId, c }: { label: string; name?: string; value: V; items: { value: V; label: string; className?: string; style?: React.CSSProperties; icon?: ReactNode }[]; onPick: (v: V) => void; trigger: ReactNode; testId: string; c: ComposerController }) {
  return (
    // closing (a pick, Esc, a click away) puts focus back in the text at once: keys typed right after must not reach the page
    <DropdownMenu onOpenChange={(open) => !open && c.focus()}>
      <Tip label={label}>
        <ToolbarButton type="button" aria-label={name ?? label} onMouseDown={keepFocus} data-testid={testId} className={tool} render={<DropdownMenuTrigger />}>
          {trigger}
          <ChevronDown className="size-3! text-muted-foreground" />
        </ToolbarButton>
      </Tip>
      <DropdownMenuContent align="start" className="w-auto min-w-40" finalFocus={() => c.dom} data-testid={`${testId}-menu`}>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(v as V)}>
          {items.map((i) => (
            <DropdownMenuRadioItem key={i.value} value={i.value} closeOnClick className={i.className} style={i.style} data-testid={`${testId}-${i.value}`}>
              {i.icon}
              {i.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A labelled row of color swatches: one radio group, arrows move and pick, as in any palette. */
function Swatches({ label, value, options, onPick, kind }: { label: string; value: string | null; options: readonly string[]; onPick: (v: string | null) => void; kind: "text" | "highlight" }) {
  const dark = isDark();
  const all = [null, ...options];
  const current = Math.max(0, all.indexOf(value));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: React.KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + all.length) % all.length;
    refs.current[next]?.focus();
    onPick(all[next]!);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground" id={`sw-${kind}`}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={`sw-${kind}`} className="flex gap-1">
        {all.map((v, i) => {
          const name = v === null ? (kind === "text" ? t("compose.format.colorDefault") : t("compose.format.highlightNone")) : t(`compose.format.swatch.${v}` as "compose.format.swatch.red");
          const checked = v === value || (v === null && value === null);
          return (
            <Tooltip key={v ?? "none"}>
              <TooltipTrigger
                render={
                  <button
                    ref={(el) => {
                      refs.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={name}
                    tabIndex={i === current ? 0 : -1}
                    onKeyDown={(e) => move(e, i)}
                    onClick={() => onPick(v)}
                    data-testid={`swatch-${kind}-${v ?? "none"}`}
                    className={cn(
                      "relative inline-flex size-6 items-center justify-center rounded-full text-2xs font-semibold outline-none ring-offset-2 ring-offset-popover transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                      checked && "ring-2 ring-foreground/70",
                      v === null && "shadow-hairline",
                    )}
                    style={v === null ? undefined : kind === "text" ? { color: swatchText(v, dark) } : { backgroundColor: swatchWash(v, dark), color: dark ? HIGHLIGHT_INK_DARK : HIGHLIGHT_INK }}
                  >
                    {v === null ? <span className="block h-px w-4 rotate-[-45deg] bg-muted-foreground" /> : kind === "text" ? <span style={{ backgroundColor: swatchText(v, dark) }} className="block size-4 rounded-full" /> : "A"}
                  </button>
                }
              />
              <TooltipContent>{name}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ColorTool({ c, s }: { c: ComposerController; s: FormatState }) {
  const dark = isDark();
  const label = t("compose.format.color");
  return (
    <Popover onOpenChange={(open) => !open && c.focus()}>
      <Tip label={label}>
        <ToolbarButton type="button" aria-label={label} onMouseDown={keepFocus} data-testid="format-color" className={tool} render={<PopoverTrigger />}>
          <span className="relative inline-flex flex-col items-center">
            <Baseline className="size-4!" />
            <span className="-mt-[3px] block h-[3px] w-3.5 rounded-full" style={{ backgroundColor: s.color ? swatchText(s.color, dark) : "currentColor", boxShadow: s.highlight ? `0 0 0 1.5px ${swatchWash(s.highlight, dark)}` : undefined }} />
          </span>
          <ChevronDown className="size-3! text-muted-foreground" />
        </ToolbarButton>
      </Tip>
      <PopoverContent align="start" className="w-auto gap-3 p-3" finalFocus={{ current: c.dom }} data-testid="format-color-popover">
        <Swatches label={t("compose.format.colorText")} value={s.color} options={TEXT_COLORS} onPick={(v) => c.setColor(v, false)} kind="text" />
        <Swatches label={t("compose.format.colorHighlight")} value={s.highlight} options={HIGHLIGHTS} onPick={(v) => c.setHighlight(v, false)} kind="highlight" />
      </PopoverContent>
    </Popover>
  );
}

type Group = { id: string; sep?: boolean; render: (c: ComposerController, s: FormatState) => ReactNode };

const ALIGN_ICON: Record<Align, ReactNode> = { left: <TextAlignStart />, center: <TextAlignCenter />, right: <TextAlignEnd /> };

const GROUPS: Group[] = [
  {
    id: "history",
    sep: true,
    render: (c, s) => (
      <>
        <Tool label={t("compose.format.undo")} keys="mod+z" disabled={!s.canUndo} onRun={() => c.run("undo")} testId="format-undo">
          <Undo2 />
        </Tool>
        <Tool label={t("compose.format.redo")} keys="mod+shift+z" disabled={!s.canRedo} onRun={() => c.run("redo")} testId="format-redo">
          <Redo2 />
        </Tool>
      </>
    ),
  },
  {
    id: "font",
    sep: true,
    render: (c, s) => {
      const items = [
        { value: "sans" as const, label: t("compose.format.font.sans"), style: { fontFamily: "Arial, Helvetica, sans-serif" } },
        { value: "serif" as const, label: t("compose.format.font.serif"), style: { fontFamily: FONT_CSS.serif } },
        { value: "mono" as const, label: t("compose.format.font.mono"), style: { fontFamily: FONT_CSS.mono } },
      ];
      const value = s.font ?? "sans";
      return (
        <ValueMenu
          c={c}
          label={t("compose.format.font")}
          // the visible font name is part of the accessible name (WCAG 2.5.3)
          name={t("compose.format.fontValue", { font: items.find((i) => i.value === value)!.label })}
          value={value}
          items={items}
          onPick={(v) => c.setFont(v === "sans" ? null : v)}
          testId="format-font"
          trigger={<span className="w-[78px] truncate px-0.5 text-left text-xs text-foreground">{items.find((i) => i.value === value)!.label}</span>}
        />
      );
    },
  },
  {
    id: "size",
    sep: true,
    render: (c, s) => (
      <ValueMenu
        c={c}
        label={t("compose.format.size")}
        value={s.size ?? "normal"}
        items={[
          { value: "small" as const, label: t("compose.format.size.small"), className: "text-xs" },
          { value: "normal" as const, label: t("compose.format.size.normal"), className: "text-sm" },
          { value: "large" as const, label: t("compose.format.size.large"), className: "text-lg" },
          { value: "huge" as const, label: t("compose.format.size.huge"), className: "text-2xl" },
        ]}
        onPick={(v) => c.setSize(v === "normal" ? null : v)}
        testId="format-size"
        trigger={<ALargeSmall />}
      />
    ),
  },
  {
    id: "style",
    render: (c, s) => (
      <>
        <Tool label={t("compose.format.bold")} keys="mod+b" pressed={s.bold} onRun={() => c.run("bold")} testId="format-bold">
          <Bold />
        </Tool>
        <Tool label={t("compose.format.italic")} keys="mod+i" pressed={s.italic} onRun={() => c.run("italic")} testId="format-italic">
          <Italic />
        </Tool>
        <Tool label={t("compose.format.underline")} keys="mod+u" pressed={s.underline} onRun={() => c.run("underline")} testId="format-underline">
          <Underline />
        </Tool>
      </>
    ),
  },
  { id: "color", sep: true, render: (c, s) => <ColorTool c={c} s={s} /> },
  {
    id: "align",
    render: (c, s) => (
      <ValueMenu
        c={c}
        label={t("compose.format.align")}
        value={s.align}
        items={(["left", "center", "right"] as const).map((a) => ({ value: a, label: t(`compose.format.align.${a}`), icon: <span className="text-muted-foreground [&_svg]:size-4">{ALIGN_ICON[a]}</span> }))}
        onPick={(v) => c.setAlign(v)}
        testId="format-align"
        trigger={ALIGN_ICON[s.align]}
      />
    ),
  },
  {
    id: "lists",
    render: (c, s) => (
      <>
        <Tool label={t("compose.format.numbered")} keys="mod+shift+7" pressed={s.list === "ordered"} onRun={() => c.run("orderedList")} testId="format-numbered">
          <ListOrdered />
        </Tool>
        <Tool label={t("compose.format.bulleted")} keys="mod+shift+8" pressed={s.list === "bullet"} onRun={() => c.run("bulletList")} testId="format-bulleted">
          <List />
        </Tool>
      </>
    ),
  },
  {
    id: "indent",
    render: (c, s) => (
      <>
        <Tool label={t("compose.format.outdent")} keys="mod+[" disabled={!s.canOutdent} onRun={() => c.run("outdent")} testId="format-outdent">
          <IndentDecrease />
        </Tool>
        <Tool label={t("compose.format.indent")} keys="mod+]" disabled={!s.canIndent} onRun={() => c.run("indent")} testId="format-indent">
          <IndentIncrease />
        </Tool>
      </>
    ),
  },
  {
    id: "quote",
    sep: true,
    render: (c, s) => (
      <Tool label={t("compose.format.quote")} pressed={s.quote} onRun={() => c.run("quote")} testId="format-quote">
        <TextQuote />
      </Tool>
    ),
  },
  {
    id: "strike",
    sep: true,
    render: (c, s) => (
      <Tool label={t("compose.format.strike")} keys="mod+shift+x" pressed={s.strike} onRun={() => c.run("strike")} testId="format-strike">
        <Strikethrough />
      </Tool>
    ),
  },
  {
    id: "clear",
    render: (c) => (
      <Tool label={t("compose.format.clear")} keys="mod+\\" onRun={() => c.run("clear")} testId="format-clear">
        <RemoveFormatting />
      </Tool>
    ),
  },
];

const MORE_W = 36;
/** what folds first when the composer is narrow (the least used); bold, italic, underline and lists stay longest */
const FOLD_ORDER = ["clear", "strike", "font", "quote", "indent", "size", "align", "history", "color", "lists", "style"];

/**
 * The format bar: Gmail's controls in Gmail's order, one tab stop (arrows
 * move), active states at the caret. When the composer is narrow the
 * trailing groups fold into "More formatting".
 */
export function FormatBar({ draftKey, className }: { draftKey: string; className?: string }) {
  const c = useController(draftKey);
  const s = useFormatState(c);
  const ref = useRef<HTMLDivElement>(null);
  const widths = useRef<number[] | null>(null);
  /** the groups shown in the bar (the rest are under More) */
  const [shownIds, setShownIds] = useState<ReadonlySet<string> | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !c) return;
    const measure = () => {
      if (!widths.current) {
        const groups = [...el.querySelectorAll<HTMLElement>("[data-format-group]")];
        if (groups.length < GROUPS.length) return;
        widths.current = groups.map((g) => g.getBoundingClientRect().width + (g.nextElementSibling?.getAttribute("data-slot") === "toolbar-separator" ? 9 : 0));
      }
      const w = widths.current;
      const room = el.clientWidth - 8;
      let used = w.reduce((a, b) => a + b, 0);
      const keep = new Set(GROUPS.map((g) => g.id));
      if (used > room) used += MORE_W;
      for (const id of FOLD_ORDER) {
        if (used <= room) break;
        keep.delete(id);
        used -= w[GROUPS.findIndex((g) => g.id === id)]!;
      }
      setShownIds((prev) => (prev && prev.size === keep.size && [...keep].every((id) => prev.has(id)) ? prev : keep));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [c]);

  if (!c) return <div className={cn("h-9", className)} aria-hidden />;
  const shown = shownIds ? GROUPS.filter((g) => shownIds.has(g.id)) : GROUPS;
  const folded = shownIds ? GROUPS.filter((g) => !shownIds.has(g.id)) : [];
  return (
    <div ref={ref} className={cn("min-w-0", className)}>
      <Toolbar aria-label={t("compose.format.toolbar")} disabled={!s.editable} data-testid="format-bar" className="h-9 gap-px overflow-hidden rounded-lg bg-(--format-bg) px-1 [box-shadow:var(--format-ring)]">
        {shown.map((g, i) => (
          <FormatGroup key={g.id} group={g} c={c} s={s} last={i === shown.length - 1 && folded.length === 0} />
        ))}
        {folded.length > 0 && (
          <Popover onOpenChange={(open) => !open && c.focus()}>
            <Tip label={t("compose.format.more")}>
              <ToolbarButton type="button" aria-label={t("compose.format.more")} onMouseDown={keepFocus} data-testid="format-more" className={tool} render={<PopoverTrigger />}>
                <Ellipsis />
              </ToolbarButton>
            </Tip>
            <PopoverContent align="end" className="w-auto p-1" finalFocus={{ current: c.dom }} data-testid="format-more-popover">
              <Toolbar aria-label={t("compose.format.more")} disabled={!s.editable} className="gap-px">
                {folded.map((g, i) => (
                  <FormatGroup key={g.id} group={g} c={c} s={s} last={i === folded.length - 1} />
                ))}
              </Toolbar>
            </PopoverContent>
          </Popover>
        )}
      </Toolbar>
    </div>
  );
}

function FormatGroup({ group, c, s, last }: { group: Group; c: ComposerController; s: FormatState; last: boolean }) {
  return (
    <>
      <ToolbarGroup data-format-group={group.id} className="gap-px">
        {group.render(c, s)}
      </ToolbarGroup>
      {group.sep && !last && <ToolbarSeparator />}
    </>
  );
}

export default RichBody;
