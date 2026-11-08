import type { PreparedReply } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useState } from "react";
import { dismissReply, stopReply, useReplies, useReply } from "~/lib/replies";
import { AI_ACTIONS, AI_CARD, AI_GAP, AI_GLYPH, AI_HEADER, AI_TITLE, gapPieces } from "./ai-card";

/** "In your voice with Ana": only what was really used, as the strip says it. */
function voice(row: PreparedReply): string {
  const used = row.used!;
  if (used.learning) return t("aiDraft.voice.learning");
  const who = row.to[0]?.name?.split(/\s+/)[0] ?? "";
  return who && (used.levels.includes("person") || used.examples > 0) ? t("aiDraft.voice.with", { name: who }) : t("aiDraft.voice.general");
}

/** Plan 161: who Use writes to, as the composer will have them: "To Liam Taylor", "To Liam Taylor and Ana Ruiz". */
export function replyTo(row: PreparedReply): string | null {
  const names = row.to.map((a) => a.name || a.email).filter(Boolean);
  if (!names.length) return null;
  return t("replies.to", { names: new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(names) });
}

/** "Press R to reply with this draft", the key a keycap in the sentence, wherever the language puts it. */
function Hint() {
  const [before, after] = t("replies.hint", { key: "\u0000" }).split("\u0000");
  return (
    <span data-testid="reply-ready-hint" className="text-xs text-muted-foreground">
      {before}
      <Shortcut keys="r" className="mx-0.5" />
      {after}
    </span>
  );
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
  const to = shown.row ? replyTo(shown.row) : null;
  const gaps = shown.row?.checks?.placeholders ?? [];
  return (
    <section data-testid="reply-ready" data-phase={shown.phase} aria-label={t("replies.title")} className={cn(AI_CARD, "mt-4 px-3.5 pb-3")}>
      {/* once, never the deltas */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="reply-ready-live">{writing ? "" : t("replies.title")}</div>
      {/* the summary's header: its height, its glyph, its type */}
      <p data-testid="reply-ready-header" className={cn(AI_HEADER, "flex-wrap gap-y-0")}>
        {/* the spinner keeps its status and name, as before the card */}
        {writing ? <Spinner className={AI_GLYPH} /> : <Sparkles aria-hidden className={AI_GLYPH} />}
        <span data-testid="reply-ready-title" className={AI_TITLE}>{writing ? t("replies.writing") : t("replies.title")}</span>
        {/* each "·" its own item, so the gaps either side are the same */}
        {!writing && to ? <><span aria-hidden>·</span><span data-testid="reply-ready-to" className="min-w-0">{to}</span></> : null}
        {!writing && shown.row?.used ? <><span aria-hidden>·</span><span data-testid="reply-ready-voice" className="min-w-0 truncate">{voice(shown.row)}</span></> : null}
      </p>
      <p data-testid="reply-ready-text" className={cn("text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap", long && !all && !writing && "line-clamp-6")}>
        {/* the gaps the model left, marked so they can't be missed (plan 161); while it writes, the words as they come */}
        {writing ? shown.text : gapPieces(shown.text, gaps).map((p, i) => (p.gap ? <mark key={i} data-testid="reply-ready-gap" className={AI_GAP}>{p.text}</mark> : p.text))}
      </p>
      {long && !writing && (
        <Button variant="link-secondary" size="xs" className="mt-1" data-testid="reply-ready-all" aria-expanded={all} onClick={() => setAll(!all)}>{t(all ? "replies.showLess" : "replies.showAll")}</Button>
      )}
      <div data-testid="reply-ready-footer" className={cn(AI_ACTIONS, "mt-3")}>
        {writing ? (
          <Button variant="outline" size="sm" data-testid="reply-ready-stop" onClick={() => stopReply(threadId)}>{t("replies.stop")}</Button>
        ) : (
          <>
            <Button size="sm" data-testid="reply-ready-use" onClick={() => void useReply(threadId)}>{t("replies.use")}</Button>
            <Button size="sm" variant="outline" data-testid="reply-ready-dismiss" onClick={() => void dismissReply(threadId)}>{t("replies.dismiss")}</Button>
            <Hint />
          </>
        )}
      </div>
    </section>
  );
}
