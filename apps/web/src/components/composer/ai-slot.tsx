import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { IconButton } from "@terno/ui/components/icon-button";
import { Shortcut, shortcutText } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Sparkles } from "@terno/ui/icons";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { glanceNow, setGlance, useAiDraftUi, useCanDraft, useNote } from "~/lib/ai-draft-state";
import { openAiDraft } from "~/lib/ai-draft";
import { useDrafts } from "~/lib/drafts";
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
 * Plan 164 (the owner): when the body is a note for AI it is **Generate**, and when it holds gaps the user marked
 * **Fill in**: BoardUI's secondary (outlined) with the glyph and its word, right after Send (the owner: "next to the send
 * button, it looks weird in the middle"), so Send stays the primary and the AI's action sits with it. Its name keeps
 * "with AI". An ordinary email leaves it the Sparkles, in the same place.
 */
export function AiDraftButton({ draftKey, threadId, disabled, testId }: { draftKey?: string; threadId?: number; disabled?: boolean; testId: string }) {
  const offered = useCanDraft();
  const glance = useAiDraftUi((s) => (draftKey ? (s.glances[draftKey] ?? "") : ""));
  const reply = useDrafts((s) => (draftKey ? (s.drafts[draftKey]?.mode ?? "new") !== "new" : false));
  // working, asking, or over a strip (where ⌘J goes to its change field): nothing here to light up
  const strip = useAiDraftUi((s) => (draftKey ? s.rows[draftKey] !== undefined && s.rows[draftKey] !== "primed" && s.rows[draftKey] !== "failed" : false));
  const note = useNote(draftKey);
  if (!offered) return null;
  const fill = /^fill:(\d+)$/.exec(glance);
  const gaps = !note && !strip && fill ? Number(fill[1]) : 0;
  const open = () => openAiDraft({ ...(draftKey ? { key: draftKey } : {}), ...(threadId !== undefined ? { threadId } : {}) });
  if (note || gaps) {
    const label = gaps ? t("aiDraft.button.fill") : t("aiDraft.button.write");
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            // the test id and data-ready are the Sparkles' (it is the Sparkles, ready): the rating's capture waits on them
            <Button type="button" variant="outline" size="sm" aria-label={label} aria-keyshortcuts="Meta+J" disabled={disabled} onMouseDown={keepSelection} onClick={open} data-testid={testId} data-ready data-note={note || undefined} className="mr-1.5 gap-1.5 px-2 @max-[31rem]/foot:mr-0 @max-[31rem]/foot:px-1 @max-[27rem]/foot:w-7 @max-[27rem]/foot:px-0 [&_svg]:[--icon-line:var(--icon-line-toolbar)]" />
          }
        >
          {/* the glyph and the word wherever the foot holds both on one line; a step narrower (1100's reply) the word
              alone, which says more; narrower still the bordered glyph alone: never a foot that wraps */}
          <Sparkles aria-hidden className="@min-[27rem]/foot:@max-[31rem]/foot:hidden" />
          <span aria-hidden className="@max-[27rem]/foot:hidden" data-testid="compose-ai-word">{gaps ? t("aiDraft.ready.fill") : t("aiDraft.ready.write")}</span>
          {/* (a picture of the key, already in aria-keyshortcuts: in the name it broke "the visible words are in the name",
              axe's label-content-name-mismatch, whenever the foot was wide enough to show it) */}
          <span aria-hidden className="contents">
            <Shortcut keys="mod+j" className="ml-0.5 @max-[36rem]/foot:hidden" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="flex max-w-72 items-center gap-2">
          {gaps ? t("aiDraft.fillIn.tip", { count: gaps }) : t("aiDraft.generate.tip")}
          <Shortcut keys="mod+j" />
        </TooltipContent>
      </Tooltip>
    );
  }
  const label = draftKey === undefined && threadId !== undefined ? t("aiDraft.buttonReply") : glance === "empty" && reply ? t("aiDraft.button.reply") : t("aiDraft.button");
  return (
    <IconButton label={label} shortcut="mod+j" disabled={disabled} onMouseDown={keepSelection} onClick={open} data-testid={testId} className="[&_svg]:[--icon-line:var(--icon-line-toolbar)]">
      <Sparkles />
    </IconButton>
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
