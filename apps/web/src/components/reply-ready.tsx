import type { Address, PreparedReply, ThreadDetail } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { SkeletonText } from "@terno/ui/components/skeleton";
import { Spinner } from "@terno/ui/components/spinner";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { Reply, ReplyAll, Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useState } from "react";
import { autoRecipients, reachesSeveral } from "~/lib/compose-fields";
import { shownDraftKey, useDrafts } from "~/lib/drafts";
import { chooseReplyAll, dismissReply, stopReply, useReplies, useReply } from "~/lib/replies";
import { useApp } from "~/state/app";
import { useThreads } from "~/state/threads";
import { AI_ACTIONS, AI_CARD, AI_GAP, AI_GLYPH, AI_HEADER, AI_TITLE, AiProvenance, gapPieces } from "./ai-card";

/**
 * Plan 161, pass 3: what the provenance says it used, the two facts the composer says too: the style ("In your voice with
 * Ana: it learned from how you write to Ana"), only what was really used, and where its words came from (no instruction:
 * this conversation alone).
 */
export function replyVoice(row: Pick<PreparedReply, "used" | "to">): string[] {
  const used = row.used;
  if (!used) return [t("aiDraft.content.alone")];
  const who = row.to[0]?.name?.split(/\s+/)[0] ?? "";
  const style = used.learning
    ? t("aiDraft.voice.stillLearning")
    : who && (used.levels.includes("person") || used.examples > 0)
      ? t("aiDraft.voice.withWhy", { name: who })
      : t("aiDraft.voice.generalWhy");
  return [style, t("aiDraft.content.alone")];
}

const named = (list: readonly Address[]): string => new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(list.map((a) => a.name || a.email).filter(Boolean));

/** Plan 161: who Use writes to, as the composer will have them: "To Liam Taylor", "To Liam Taylor and Ana Ruiz". */
export function replyTo(row: PreparedReply): string | null {
  if (!row.to.some((a) => a.name || a.email)) return null;
  return t("replies.to", { names: named(row.to) });
}

/**
 * Plan 144, owner's decisions (2): on a conversation with others in it, Reply all's people, as the reply bar's Reply all
 * puts them in the composer: "To Liam Taylor, cc Ana Ruiz and Ben Wu". Null where Reply all reaches no one Reply doesn't.
 */
export function replyAllTo(detail: ThreadDetail, mine: readonly string[]): string | null {
  if (!reachesSeveral(detail, mine)) return null;
  const { to, cc } = autoRecipients("replyAll", detail, mine);
  return cc.length ? t("replies.toAll", { names: named(to), cc: named(cc) }) : t("replies.to", { names: named(to) });
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

/** Plan 161, pass 2: the model's gaps still in the text, so the header says the draft isn't whole before Use. */
export function gapsToFill(text: string, gaps: readonly string[]): number {
  return [...new Set(gaps.filter(Boolean))].filter((g) => text.includes(g)).length;
}

/**
 * Plan 144 §5: below the last message, in the conversation's column, on the summary's card (the addendum), so words a model
 * wrote never read as the mail's: the label is its header, the draft is inset, and Use and Dismiss are its footer. Focus never moves.
 *
 * Plan 161, pass 2: it shows from the moment the backend starts writing (never for a reply that won't come), holding its
 * place with skeleton lines until words arrive, and the text is clamped at six lines while it writes as once it's ready,
 * so the page under it moves once, a bounded step, faded in within --motion.
 */
export default function ReplyReady({ threadId }: { threadId: number }) {
  const shown = useReplies((s) => (s.shown?.threadId === threadId ? s.shown : null));
  // a draft open here is the reply (the discard snack's Undo brings one back while the reply is offered again)
  const drafted = useDrafts((s) => shownDraftKey(s.drafts, threadId, useApp.getState().draftShown) !== null);
  const [all, setAll] = useState(false);
  // owner's decisions (2): Reply or Reply all, offered where the reply bar offers Reply all; Reply first, as there
  const detail = useThreads((s) => s.details.get(threadId));
  const accounts = useApp((s) => s.accounts);
  const everyone = detail ? replyAllTo(detail, accounts.map((a) => a.email)) : null;
  const toAll = useReplies((s) => s.all === threadId) && everyone !== null;
  if (!shown || drafted) return null;
  const writing = shown.phase === "writing";
  const lines = shown.text.split("\n").length;
  const long = lines > 6 || shown.text.length > 480;
  const to = toAll ? everyone : shown.row ? replyTo(shown.row) : null;
  const gaps = shown.row?.checks?.placeholders ?? [];
  const toFill = writing ? 0 : gapsToFill(shown.text, gaps);
  return (
    <section data-testid="reply-ready" data-phase={shown.phase} aria-label={t("replies.title")} className={cn(AI_CARD, "mt-4 px-3.5 pb-3 animate-in fade-in-0 duration-base ease-motion")}>
      {/* once, never the deltas */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="reply-ready-live">{writing ? "" : t("replies.title")}</div>
      {/* the summary's header: its height, its glyph, its type */}
      <div data-testid="reply-ready-header" className={cn(AI_HEADER, "flex-wrap gap-y-0")}>
        {/* the spinner keeps its status and name, as before the card */}
        {writing ? <Spinner className={AI_GLYPH} /> : <Sparkles aria-hidden className={AI_GLYPH} />}
        <span data-testid="reply-ready-title" className={AI_TITLE}>{writing ? t("replies.writing") : t("replies.title")}</span>
        {/* what's left for the user, said before Use, in the ink */}
        {toFill > 0 && <><span aria-hidden>·</span><span data-testid="reply-ready-gaps" className="font-medium text-foreground">{t("replies.gaps", { count: toFill })}</span></>}
        {/* each "·" its own item, so the gaps either side are the same; the voice is the provenance's to explain (pass 3) */}
        {!writing && to ? <><span aria-hidden>·</span><span data-testid="reply-ready-to" className="min-w-0">{to}</span></> : null}
        {/* the reply bar's two answers in its words and glyphs, on the header's end; the track sits in the header's
            40 px without growing it. The words stay as written: if they greet only the sender, the user edits */}
        {!writing && everyone !== null && (
          <ToggleGroup
            data-testid="reply-ready-mode"
            aria-label={t("replies.mode")}
            variant="segmented"
            className="ms-auto -my-1.5"
            value={[toAll ? "replyAll" : "reply"]}
            onValueChange={(v: string[]) => v[0] && chooseReplyAll(threadId, v[0] === "replyAll")}
          >
            <ToggleGroupItem value="reply" data-testid="reply-ready-mode-reply" className="h-6 px-2 text-xs">
              <Reply aria-hidden /> {t("actions.reply")}
            </ToggleGroupItem>
            <ToggleGroupItem value="replyAll" data-testid="reply-ready-mode-all" className="h-6 px-2 text-xs">
              <ReplyAll aria-hidden /> {t("compose.bar.replyAll")}
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      {writing && !shown.text.trim() ? (
        // its place held until the first words: three lines of the text's height
        <SkeletonText data-testid="reply-ready-skeleton" lines={3} className="py-1.5" lineClassName="h-3" />
      ) : (
        <p data-testid="reply-ready-text" className={cn("text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap", (writing || (long && !all)) && "line-clamp-6")}>
          {/* the gaps the model left, marked so they can't be missed (plan 161); while it writes, the words as they come */}
          {writing ? shown.text : gapPieces(shown.text, gaps).map((p, i) => (p.gap ? <mark key={i} data-testid="reply-ready-gap" className={AI_GAP}>{p.text}</mark> : p.text))}
        </p>
      )}
      {long && !writing && (
        <Button variant="link-secondary" size="xs" className="mt-1" data-testid="reply-ready-all" aria-expanded={all} onClick={() => setAll(!all)}>{t(all ? "replies.showLess" : "replies.showAll")}</Button>
      )}
      <div data-testid="reply-ready-footer" className={cn(AI_ACTIONS, "mt-3")}>
        {writing ? (
          <Button variant="outline" size="sm" className="text-foreground" data-testid="reply-ready-stop" onClick={() => stopReply(threadId)}>{t("replies.stop")}</Button>
        ) : (
          <>
            <Button size="sm" data-testid="reply-ready-use" aria-keyshortcuts="r" onClick={() => void useReply(threadId)}>{t("replies.use")}</Button>
            <Button size="sm" variant="outline" className="text-foreground" data-testid="reply-ready-dismiss" onClick={() => void dismissReply(threadId)}>{t("replies.dismiss")}</Button>
            {/* the one R on screen: the reply bar's keycap steps aside while this shows (plan 161, pass 2) */}
            <Hint />
            {shown.row && <AiProvenance model={shown.row.model ?? ""} at={shown.row.generatedAt} lines={replyVoice(shown.row)} testId="reply-ready-provenance" className="-me-1.5 ms-auto" />}
          </>
        )}
      </div>
    </section>
  );
}
