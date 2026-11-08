import type { PreparedReply } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useState } from "react";
import { dismissReply, stopReply, useReplies, useReply } from "~/lib/replies";
import { AI_CARD, AI_GLYPH } from "./ai-card";

/** "In your voice with Ana": only what was really used, as the strip says it. */
function voice(row: PreparedReply): string {
  const used = row.used!;
  if (used.learning) return t("aiDraft.voice.learning");
  const who = row.to[0]?.name?.split(/\s+/)[0] ?? "";
  return who && (used.levels.includes("person") || used.examples > 0) ? t("aiDraft.voice.with", { name: who }) : t("aiDraft.voice.general");
}

/**
 * Plan 144 §5: below the last message, in the conversation's column, on the summary's card (the addendum), so words a model
 * wrote never read as the mail's: the label is its header, the draft is inset, and Use and Dismiss are its footer. Focus never moves.
 */
export default function ReplyReady({ threadId }: { threadId: number }) {
  const shown = useReplies((s) => (s.shown?.threadId === threadId ? s.shown : null));
  const [all, setAll] = useState(false);
  if (!shown) return null;
  const writing = shown.phase === "writing";
  const lines = shown.text.split("\n").length;
  const long = lines > 6 || shown.text.length > 480;
  return (
    <section data-testid="reply-ready" data-phase={shown.phase} aria-label={t("replies.title")} className={cn(AI_CARD, "mt-4 px-3.5 pb-3")}>
      {/* once, never the deltas */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="reply-ready-live">{writing ? "" : t("replies.title")}</div>
      {/* the summary's header: its height, its glyph, its type */}
      <p data-testid="reply-ready-header" className="flex min-h-10 items-center gap-1.5 py-2.5 text-xs text-muted-foreground">
        {/* the spinner keeps its status and name, as before the card */}
        {writing ? <Spinner className={AI_GLYPH} /> : <Sparkles aria-hidden className={AI_GLYPH} />}
        <span data-testid="reply-ready-title" className="font-medium">{writing ? t("replies.writing") : t("replies.title")}</span>
        {!writing && shown.row?.used ? <span data-testid="reply-ready-voice" className="min-w-0 truncate"><span aria-hidden>·</span> {voice(shown.row)}</span> : null}
      </p>
      <p data-testid="reply-ready-text" className={cn("text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap", long && !all && !writing && "line-clamp-6")}>{shown.text}</p>
      {long && !writing && (
        <Button variant="link-secondary" size="xs" className="mt-1" data-testid="reply-ready-all" aria-expanded={all} onClick={() => setAll(!all)}>{t(all ? "replies.showLess" : "replies.showAll")}</Button>
      )}
      <div data-testid="reply-ready-footer" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {writing ? (
          <Button variant="link-secondary" size="xs" data-testid="reply-ready-stop" onClick={() => stopReply(threadId)}>{t("replies.stop")}</Button>
        ) : (
          <>
            <Button size="xs" data-testid="reply-ready-use" onClick={() => void useReply(threadId)}>{t("replies.use")}</Button>
            <Button size="xs" variant="outline" data-testid="reply-ready-dismiss" onClick={() => void dismissReply(threadId)}>{t("replies.dismiss")}</Button>
            <span>{t("replies.hint")} <Shortcut keys="r" /></span>
          </>
        )}
      </div>
    </section>
  );
}
