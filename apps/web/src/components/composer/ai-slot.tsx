import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { IconButton } from "@terno/ui/components/icon-button";
import { Shortcut, shortcutText } from "@terno/ui/components/shortcut";
import { cn } from "@terno/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Send, Sparkles } from "@terno/ui/icons";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { glanceNow, setGlance, useAiDraftUi, useCanDraft, useNote } from "~/lib/ai-draft-state";
import { openAiDraft } from "~/lib/ai-draft";
import { useDrafts, type LocalDraft } from "~/lib/drafts";
import { Popover, PopoverContent } from "@terno/ui/components/popover";
import { SendButton, useSendLater } from "../send-button";
import { SendLaterPicker } from "../send-later-picker";
import { AiPreview, AiRow } from "./ai-draft";
import { useController } from "./controller";

/**
 * Plan 133: the doors to the AI row and preview: each renders nothing until the draft has the row up. The Sparkles
 * button is the only one always there.
 */

export function AiRowSlot({ draftKey }: { draftKey: string }) {
  const up = useAiDraftUi((s) => s.rows[draftKey] !== undefined);
  if (!up) return null;
  return <AiRow draftKey={draftKey} />;
}

export function AiPreviewSlot({ draftKey, className }: { draftKey: string; className?: string }) {
  const up = useAiDraftUi((s) => s.rows[draftKey] !== undefined);
  if (!up) return null;
  return <AiPreview draftKey={draftKey} className={className} />;
}

// a click here mustn't take the caret away from the text the row will come back to
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

/** a glance while typing: at most this often, and never when nothing changes */
const GLANCE_MS = 150;

/**
 * Plan 163: what ⌘J would do with the body as it is, read on this machine (rules only): `write` from an instruction,
 * `fill:<n>` gaps, `empty`, or "" (the user's own email, or AI can't tell without asking). Reads the editor's blocks up to
 * a limit, never serializing, and only after the text changes.
 */
function useBodyGlance(draftKey: string | undefined): void {
  const c = useController(draftKey);
  useEffect(() => {
    if (!c || !draftKey) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      timer = null;
      // plan 162 (after ai162-r04): published, so the body, the foot and Send read one glance (the note for AI), kept by
      // the body (always there with its editor), not by a button the foot can swap out
      setGlance(draftKey, glanceNow(draftKey) ?? "");
    };
    look();
    const off = c.subscribeDoc(() => {
      timer ??= setTimeout(look, GLANCE_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
      setGlance(draftKey, null);
    };
  }, [c, draftKey]);
}

/**
 * The quiet Sparkles in a draft's footer and on the reply bar. Plan 161, pass 3: each says what it does, beside the reader's
 * own Sparkles (Summarize this conversation): the reply bar's starts a reply ("Reply with AI"), a draft's writes in it.
 * Plan 163: a draft's is quiet at rest and clearer (full ink, named for it) when the body holds an instruction or a gap;
 * an ordinary email being typed leaves it as it was.
 */
export function AiDraftButton({ draftKey, threadId, disabled, testId }: { draftKey?: string; threadId?: number; disabled?: boolean; testId: string }) {
  const offered = useCanDraft();
  const glance = useAiDraftUi((s) => (draftKey ? (s.glances[draftKey] ?? "") : ""));
  const reply = useDrafts((s) => (draftKey ? (s.drafts[draftKey]?.mode ?? "new") !== "new" : false));
  // working, asking, or over a strip (where ⌘J is Regenerate): nothing here to light up
  const strip = useAiDraftUi((s) => (draftKey ? s.rows[draftKey] !== undefined && s.rows[draftKey] !== "primed" : false));
  const note = useNote(draftKey);
  // a note for AI: Write it is the primary, in Send's place (`SendOrWrite`), so the foot's own Sparkles steps out
  if (!offered || note) return null;
  const fill = /^fill:(\d+)$/.exec(glance);
  const ready = !strip && (glance === "write" || fill !== null);
  const label =
    draftKey === undefined && threadId !== undefined
      ? t("aiDraft.buttonReply")
      : ready
        ? fill
          ? t("aiDraft.button.fill", { count: Number(fill[1]) })
          : t("aiDraft.button.write")
        : glance === "empty" && reply
          ? t("aiDraft.button.reply")
          : t("aiDraft.button");
  const open = () => openAiDraft({ ...(draftKey ? { key: draftKey } : {}), ...(threadId !== undefined ? { threadId } : {}) });
  // ready: a word beside the glyph says what ⌘J will do (in Lumen the foot's icons are all near the ink: a darker glyph
  // alone didn't read as a change), in the reply bar's quiet button style
  if (ready) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="button" variant="ghost" size="sm" aria-label={label} disabled={disabled} onMouseDown={keepSelection} onClick={open} data-testid={testId} data-ready className="gap-1 px-2 text-foreground-soft hover:text-foreground [&_svg]:size-[1.15em] [&_svg]:text-foreground [&_svg]:[--icon-line:var(--icon-line-toolbar)] @min-[36rem]/foot:[&_svg]:text-muted-foreground @min-[36rem]/foot:hover:[&_svg]:text-foreground" />
          }
        >
          <Sparkles aria-hidden />
          {/* only where the foot has room for it: a word that wrapped the foot onto a second line would move it while typing */}
          <span aria-hidden className="hidden @min-[36rem]/foot:inline" data-testid="compose-ai-word">{fill ? t("aiDraft.ready.fill", { count: Number(fill[1]) }) : t("aiDraft.ready.write")}</span>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          {label}
          <Shortcut keys="mod+j" />
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <IconButton label={label} shortcut="mod+j" disabled={disabled} onMouseDown={keepSelection} onClick={open} data-testid={testId} className="[&_svg]:[--icon-line:var(--icon-line-toolbar)]">
      <Sparkles />
    </IconButton>
  );
}

/**
 * Plan 162 (after ai162-r04): Send, or, while the body is a note for AI, **Write it** in its place (the primary, with its ⌘J
 * keycap) and Send stepped back to an icon-only secondary that asks first. One place at every width: the foot doesn't
 * change with the window, only with what the body is.
 */
export function SendOrWrite({ d, onSend, className }: { d: LocalDraft; onSend: (sendAt?: number) => void; className?: string }) {
  const note = useNote(d.key);
  const later = useSendLater((s) => s.open === d.key);
  const sendRef = useRef<HTMLButtonElement>(null);
  const offId = useId();
  if (!note) return <SendButton d={d} onSend={onSend} className={className} />;
  const disabled = d.sending || Boolean(d.recovery);
  const off = t("aiDraft.note.sendOff", { keys: shortcutText("mod+enter") });
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)} data-testid="compose-note-actions">
      <Tooltip>
        <TooltipTrigger
          render={
            // the test id and data-ready are the Sparkles' (it is the Sparkles, ready): the rating's capture waits on them
            <Button type="button" size="sm" data-testid="compose-ai" data-ready data-note aria-label={t("aiDraft.button.write")} aria-keyshortcuts="Meta+J" disabled={disabled} onMouseDown={keepSelection} onClick={() => openAiDraft({ key: d.key })} className="gap-1.5 [&_kbd]:bg-transparent [&_kbd]:text-current [&_kbd]:shadow-[inset_0_0_0_1px_color-mix(in_oklab,currentColor_45%,transparent)]" />
          }
        >
          <Sparkles aria-hidden />
          {t("aiDraft.ready.write")}
          <Shortcut keys="mod+j" className="ml-0.5" />
        </TooltipTrigger>
        <TooltipContent>{t("aiDraft.button.write")}</TooltipContent>
      </Tooltip>
      {/* plan 162 (after ai162-r05): a note is never one click from going. Send is off (aria-disabled, so its reason still
          shows on hover and to assistive tech); ⌘↵, Send later and the palette ask "This reads as a note for AI.", whose
          Send as it is is the one way to mail the note itself */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button ref={sendRef} type="button" variant="outline" size="icon-sm" aria-label={t("common.send")} aria-disabled aria-describedby={offId} data-testid="compose-send" data-note onClick={(e) => e.preventDefault()} className="text-muted-foreground opacity-60 hover:bg-transparent aria-disabled:cursor-default" />
          }
        >
          <Send />
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{off}</TooltipContent>
      </Tooltip>
      <span id={offId} className="sr-only">{off}</span>
      {/* Send later (⌘⇧↩) keeps its picker, at Send's place; what it picks goes through Send's question (Codex review) */}
      <Popover open={later} onOpenChange={(o) => useSendLater.setState({ open: o ? d.key : null })}>
        <PopoverContent anchor={sendRef} side="top" align="start" sideOffset={6} className="w-72 gap-2 rounded-menu p-1.5" data-testid="send-later-popover" aria-label={t("sendLater.title")}>
          <SendLaterPicker sendKeys="mod+enter" done={() => useSendLater.setState({ open: null })} onPick={(at) => onSend(at === "now" ? undefined : at)} />
        </PopoverContent>
      </Popover>
    </span>
  );
}

/**
 * Plan 162 (after ai162-r04): the body says it's a note for AI while it is one: a faint wash behind it and "✦ For AI" at
 * its first line's end (which that line keeps clear), and the editor's description says the same. Nothing on a plain draft.
 */
export function AiNoteSlot({ draftKey }: { draftKey: string }) {
  const offered = useCanDraft();
  useBodyGlance(offered ? draftKey : undefined);
  const note = useNote(draftKey);
  if (!note) return null;
  return <AiNote />;
}

function AiNote() {
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    host.setAttribute("data-ai-note", "");
    const body = host.querySelector<HTMLElement>("[data-testid=compose-body]");
    const was = body?.getAttribute("aria-describedby") ?? null;
    body?.setAttribute("aria-describedby", [was, id].filter(Boolean).join(" "));
    return () => {
      host.removeAttribute("data-ai-note");
      if (!body) return;
      if (was === null) body.removeAttribute("aria-describedby");
      else body.setAttribute("aria-describedby", was);
    };
  }, [id]);
  return (
    <span ref={ref} aria-hidden className="pointer-events-none absolute top-3 right-3.5 z-[1] flex items-center gap-1 text-xs leading-6 text-muted-foreground [&_svg]:size-[1.15em]" data-testid="ai-note-label">
      <Sparkles aria-hidden />
      {t("aiDraft.note.label")}
      <span id={id} className="sr-only">{t("aiDraft.note.description", { keys: shortcutText("mod+j") })}</span>
    </span>
  );
}
