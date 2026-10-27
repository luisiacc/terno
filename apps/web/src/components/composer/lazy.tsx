import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { CaseSensitive, Link2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { encodeSpaces, escapeHtml } from "@terno/richtext/quote";
import { attachBody, useDrafts } from "~/lib/drafts";
import { controllerFor, toggleFormatBar, useFormatBar } from "./controller";

/**
 * The rich composer's entry points (plan 16): the editor and its format bar
 * live in a lazy chunk, loaded on intent (a conversation opened, the compose
 * button hovered or focused, a draft opened) and then kept.
 */

type Rich = typeof import("./rich");
let loading: Promise<Rich> | null = null;
let loaded: Rich | null = null;
const listeners = new Set<() => void>();
export const loadComposer = (): Promise<Rich> =>
  (loading ??= import("./rich").then((m) => {
    loaded = m;
    for (const l of listeners) l();
    return m;
  }));
/** Starts loading the editor (idempotent). */
export function preloadComposer(): void {
  void loadComposer();
}
/** The editor module once loaded: rendered in the same commit as its draft (no suspense gap for a fast "r"). */
function useRich(): Rich | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void loadComposer();
      return () => listeners.delete(l);
    },
    () => loaded,
  );
}

/**
 * What was typed into a body before its editor loaded, by draft. The stand-in
 * is the draft's body source meanwhile (saved and sent like the editor's: the
 * draft's body with these lines after it), and the editor takes it over when
 * it mounts.
 */
interface Early {
  /** the draft's body when typing started */
  base: { text: string; html: string };
  text: string;
  focused: boolean;
  body: ReturnType<typeof attachBody>;
}
const early = new Map<string, Early>();

/** The stand-in's body: what the draft had, then the typed lines (one per line, as the editor appends them). */
export function withTyped(base: { text: string; html: string }, typed: string): { text: string; html: string } {
  const lines = typed.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  if (!lines) return base;
  // the same lines the editor will make of them: one plain paragraph each
  const html = lines.split("\n").map((l) => `<div>${encodeSpaces(escapeHtml(l), true, true) || "<br>"}</div>`).join("");
  return { text: base.text ? `${base.text}\n${lines}` : lines, html: base.html ? `${base.html}${html}` : "" };
}

function typedIn(key: string, text: string, focused: boolean) {
  let e = early.get(key);
  if (!e) {
    const d = useDrafts.getState().drafts[key];
    const base = { text: d?.bodyText ?? "", html: d?.bodyHtml ?? "" };
    // a stored body that never went through the schema stays untrusted: the send re-reads it
    const canonical = !base.html || d?.canonical === true;
    const entry: Early = { base, text: "", focused, body: attachBody(key, () => withTyped(entry.base, entry.text), { canonical }) };
    early.set(key, (e = entry));
  }
  const changed = e.text !== text;
  e.text = text;
  e.focused = focused;
  if (changed) e.body.changed();
}

/** A stand-in mounted again (the draft collapsed and reopened while loading) shows what it already has. */
const restoreTyped = (key: string) => (el: HTMLDivElement | null) => {
  const e = early.get(key);
  if (el && e && el.innerText !== e.text) el.innerText = e.text;
};

/** Stand-ins that have focus: the editor replacing one takes it (typed into or not). */
const focusedStandIns = new Set<string>();
export const takeStandInFocus = (key: string): boolean => focusedStandIns.delete(key);

/** For the editor, once: what the stand-in got (its source is the editor's from now on). */
export function takeEarly(key: string): { base: { text: string; html: string }; text: string; focused: boolean } | null {
  const e = early.get(key);
  if (!e) return null;
  early.delete(key);
  return { base: e.base, text: e.text, focused: e.focused };
}

/**
 * The draft's body: the editor once loaded. Until then (a first open on a slow
 * disk) a plain editable stand-in in the same place, so keys typed at once are
 * kept and handed to the editor.
 */
export function ComposerBody({ draftKey, placeholder, className }: { draftKey: string; placeholder: string; className?: string }) {
  const rich = useRich();
  // read-only under a send in flight, as the editor is (what is typed then couldn't be part of it)
  const sending = useDrafts((s) => s.held || (s.drafts[draftKey]?.sending ?? false));
  if (rich) return <rich.RichBody draftKey={draftKey} placeholder={placeholder} className={className} />;
  return (
    <div
      role="textbox"
      aria-multiline="true"
      aria-label={t("compose.body")}
      aria-placeholder={placeholder}
      contentEditable={sending ? "false" : "plaintext-only"}
      suppressContentEditableWarning
      tabIndex={0}
      data-testid="compose-body-loading"
      ref={restoreTyped(draftKey)}
      onInput={(e) => typedIn(draftKey, e.currentTarget.innerText, true)}
      onFocus={() => focusedStandIns.add(draftKey)}
      onBlur={(e) => {
        // an unmount (the editor arriving) blurs too: that focus is the editor's to take
        if (!e.currentTarget.isConnected) return;
        focusedStandIns.delete(draftKey);
        if (early.has(draftKey)) typedIn(draftKey, e.currentTarget.innerText, false);
      }}
      className={cn("type-body outline-none whitespace-pre-wrap empty:before:text-muted-foreground empty:before:content-[attr(aria-placeholder)]", className)}
    />
  );
}

/** The format bar, when shown (Aa). */
export function ComposerFormatBar({ draftKey, id, className }: { draftKey: string; id: string; className?: string }) {
  const shown = useFormatBar((s) => s.shown);
  const rich = useRich();
  if (!shown) return null;
  return (
    <div id={id} className={className}>
      {rich ? <rich.FormatBar draftKey={draftKey} /> : <div className="h-9" aria-hidden />}
    </div>
  );
}

const quiet = "text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground [&_svg]:[stroke-width:var(--icon-stroke-toolbar)]";
// a click here mustn't take the selection away from the text it formats
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

/** "Aa": shows or hides the format bar (remembered on this device). */
export function FormatToggle({ controls }: { controls: string }) {
  const shown = useFormatBar((s) => s.shown);
  const label = t("compose.format.toggle");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-expanded={shown} aria-controls={controls} onMouseDown={keepSelection} onClick={toggleFormatBar} data-testid="format-toggle" className={quiet}>
            <CaseSensitive className="size-[18px]!" />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Insert link (⌘K): the editor's link popover for the selection. */
export function LinkButton({ draftKey, disabled }: { draftKey: string; disabled?: boolean }) {
  const label = t("compose.link.button");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onMouseDown={keepSelection} onClick={() => controllerFor(draftKey)?.openLink()} data-testid="compose-link" className={quiet}>
            <Link2 />
          </Button>
        }
      />
      <TooltipContent>
        {label}
        <Shortcut keys="mod+k" />
      </TooltipContent>
    </Tooltip>
  );
}
