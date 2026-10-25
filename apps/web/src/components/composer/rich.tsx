import "./rich.css";
import { FONT_CSS, HIGHLIGHT_DARK, HIGHLIGHT_HEX, HIGHLIGHT_INK, HIGHLIGHT_INK_DARK, HIGHLIGHTS, normalizeHref, TEXT_COLORS, TEXT_DARK, TEXT_HEX, schema } from "@terno/richtext";
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
  AlignCenter,
  AlignLeft,
  AlignRight,
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
  TextQuote,
  Underline,
  Undo2,
  Unlink,
} from "lucide-react";
import { TextSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { attachBody, useDrafts } from "~/lib/drafts";
import { openLink } from "../mail-body";
import { typedEarly } from "./lazy";
import { EMPTY_FORMAT, registerController, useController, useFormatState, type Align, type ComposerController, type FormatCommand, type FormatState } from "./controller";
import { applyLink, COMMANDS, createEditor, docOf, formatState, keepState, keptState, linkAt, newState, removeLink, sameFormat, serialize, setAlign, setMark } from "./editor";

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
      `.rt-body [data-rt-highlight="${h}"]{background-color:${HIGHLIGHT_HEX[h]}!important;color:${HIGHLIGHT_INK}}`,
      `.dark .rt-body [data-rt-highlight="${h}"]{background-color:${HIGHLIGHT_DARK[h]}!important;color:${HIGHLIGHT_INK_DARK}}`,
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

interface LinkDraft {
  from: number;
  to: number;
  text: string;
  href: string;
  /** the text field shows when the range is text within one line */
  textEditable: boolean;
  editing: boolean;
}

export function RichBody({ draftKey, placeholder, className }: { draftKey: string; placeholder: string; className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const version = useDrafts((s) => s.drafts[draftKey]?.bodyVersion ?? 0);
  const sending = useDrafts((s) => s.drafts[draftKey]?.sending ?? false);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const versionRef = useRef(version);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [bubble, setBubble] = useState<{ from: number; to: number; href: string; top: number; left: number } | null>(null);
  const bodyRef = useRef<ReturnType<typeof attachBody> | null>(null);
  const openLinkRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    stylePalette();
    const mount = mountRef.current!;
    const d = useDrafts.getState().drafts[draftKey];
    if (!d) return;
    versionRef.current = d.bodyVersion;
    const state = keptState(draftKey, d.bodyVersion) ?? newState(docOf(d.bodyHtml, d.bodyText));
    let format: FormatState = EMPTY_FORMAT;
    const listeners = new Set<() => void>();
    let frame = 0;
    let focusedOnce = false;
    // the toolbar's state, once per frame at most (a long selection is walked once, not per transaction)
    const publish = () => {
      frame = 0;
      const view = viewRef.current;
      if (!view) return;
      const next = formatState(view.state, !sendingRef.current);
      if (!sameFormat(next, format)) {
        format = next;
        for (const l of listeners) l();
      }
      updateBubble(view);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(publish);
    };
    const emptyClass = (view: EditorView) => view.dom.classList.toggle("is-empty", serializeEmpty(view.state));
    const editor = createEditor(mount, {
      state,
      editable: () => !sendingRef.current,
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("compose.body"),
        "aria-placeholder": placeholder,
        "data-placeholder": placeholder,
        "data-testid": "compose-body",
        spellcheck: "true",
        class: cn("rt-body type-body", className),
      },
      hooks: {
        onChange: () => {
          bodyRef.current?.changed();
          if (viewRef.current) emptyClass(viewRef.current);
        },
        onUpdate: schedule,
        onLink: () => openLinkRef.current(),
        openLink,
      },
    });
    const view = editor.view;
    viewRef.current = view;
    emptyClass(view);
    bodyRef.current = attachBody(draftKey, () => serialize(view.state.doc));
    const focus = (where: "end" | "keep" = "keep") => {
      if (where === "end" && !focusedOnce) view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      focusedOnce = true;
      view.focus();
    };
    const controller: ComposerController = {
      run: (command: FormatCommand) => {
        COMMANDS[command](view.state, view.dispatch, view);
        view.focus();
      },
      setFont: (v) => run(setMark(schema.marks.font, v)),
      setSize: (v) => run(setMark(schema.marks.size, v)),
      setColor: (v) => run(setMark(schema.marks.color, v)),
      setHighlight: (v) => run(setMark(schema.marks.highlight, v)),
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
    function run(cmd: (s: EditorState, d?: EditorView["dispatch"]) => boolean) {
      cmd(view.state, view.dispatch);
      view.focus();
    }
    format = formatState(view.state, !sendingRef.current);
    // keys typed into the stand-in while this chunk loaded: kept, at the end, and focus follows
    const early = typedEarly.get(draftKey);
    if (early) {
      typedEarly.delete(draftKey);
      if (early.text) view.dispatch(view.state.tr.insertText(early.text.replace(/\u00a0/g, " "), view.state.doc.content.size - 1));
      if (early.focused) focus("end");
    }
    const unregister = registerController(draftKey, controller);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      keepState(draftKey, view.state, versionRef.current);
      bodyRef.current?.dispose();
      bodyRef.current = null;
      unregister();
      viewRef.current = null;
      editor.destroy();
    };
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
  }, [sending]);

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
      <div ref={mountRef} />
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

function serializeEmpty(state: EditorState): boolean {
  return serialize(state.doc).html === "" && state.doc.childCount === 1;
}

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
    <DropdownMenu>
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
    <Popover>
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
        <Swatches label={t("compose.format.colorText")} value={s.color} options={TEXT_COLORS} onPick={(v) => c.setColor(v)} kind="text" />
        <Swatches label={t("compose.format.colorHighlight")} value={s.highlight} options={HIGHLIGHTS} onPick={(v) => c.setHighlight(v)} kind="highlight" />
      </PopoverContent>
    </Popover>
  );
}

type Group = { id: string; sep?: boolean; render: (c: ComposerController, s: FormatState) => ReactNode };

const ALIGN_ICON: Record<Align, ReactNode> = { left: <AlignLeft />, center: <AlignCenter />, right: <AlignRight /> };

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
      <Toolbar aria-label={t("compose.format.toolbar")} data-testid="format-bar" className="h-9 gap-px overflow-hidden rounded-lg bg-(--format-bg) px-1 [box-shadow:var(--format-ring)]">
        {shown.map((g, i) => (
          <FormatGroup key={g.id} group={g} c={c} s={s} last={i === shown.length - 1 && folded.length === 0} />
        ))}
        {folded.length > 0 && (
          <Popover>
            <Tip label={t("compose.format.more")}>
              <ToolbarButton type="button" aria-label={t("compose.format.more")} onMouseDown={keepFocus} data-testid="format-more" className={tool} render={<PopoverTrigger />}>
                <Ellipsis />
              </ToolbarButton>
            </Tip>
            <PopoverContent align="end" className="w-auto p-1" finalFocus={{ current: c.dom }} data-testid="format-more-popover">
              <Toolbar aria-label={t("compose.format.more")} className="gap-px">
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
