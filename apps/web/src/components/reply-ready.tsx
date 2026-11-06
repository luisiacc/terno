import type { PreparedReply } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { useState } from "react";
import { dismissReply, stopReply, useReplies, useReply } from "~/lib/replies";

/** "In your voice with Ana": only what was really used, as the strip says it. */
function voice(row: PreparedReply): string {
  const used = row.used!;
  if (used.learning) return t("aiDraft.voice.learning");
  const who = row.to[0]?.name?.split(/\s+/)[0] ?? "";
  return who && (used.levels.includes("person") || used.examples > 0) ? t("aiDraft.voice.with", { name: who }) : t("aiDraft.voice.general");
}

/** Plan 144 §5: below the last message, in the conversation's text column. A hairline and type, no card; focus never moves. */
export default function ReplyReady({ threadId }: { threadId: number }) {
  const shown = useReplies((s) => (s.shown?.threadId === threadId ? s.shown : null));
  const [all, setAll] = useState(false);
  if (!shown) return null;
  const writing = shown.phase === "writing";
  const lines = shown.text.split("\n").length;
  const long = lines > 6 || shown.text.length > 480;
  return (
    <section data-testid="reply-ready" data-phase={shown.phase} aria-label={t("replies.title")} className="mt-3 space-y-1.5">
      {/* once, never the deltas */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="reply-ready-live">{writing ? "" : t("replies.title")}</div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {writing ? <Spinner className="size-3" /> : null}
        <span data-testid="reply-ready-title">{writing ? t("replies.writing") : t("replies.title")}</span>
        {!writing && shown.row?.used ? <span data-testid="reply-ready-voice"><span aria-hidden>·</span> {voice(shown.row)}</span> : null}
      </p>
      <p data-testid="reply-ready-text" className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${long && !all && !writing ? "line-clamp-6" : ""}`}>{shown.text}</p>
      {long && !writing && (
        <Button variant="link-secondary" size="xs" data-testid="reply-ready-all" aria-expanded={all} onClick={() => setAll(!all)}>{t(all ? "replies.showLess" : "replies.showAll")}</Button>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {writing ? (
          <Button variant="link-secondary" size="xs" data-testid="reply-ready-stop" onClick={() => stopReply(threadId)}>{t("replies.stop")}</Button>
        ) : (
          <>
            <Button size="xs" data-testid="reply-ready-use" onClick={() => void useReply(threadId)}>{t("replies.use")}</Button>
            <Button size="xs" variant="secondary" data-testid="reply-ready-dismiss" onClick={() => void dismissReply(threadId)}>{t("replies.dismiss")}</Button>
            <span>{t("replies.hint")} <Shortcut keys="r" /></span>
          </>
        )}
      </div>
    </section>
  );
}
