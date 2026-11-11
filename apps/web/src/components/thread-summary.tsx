import type { AiSummary, AiSummaryItem, MessageDetail, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, BadgeCheck, CalendarDays, ListChecks, MessageSquareText, Reply, Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useRef } from "react";
import { routeOf } from "~/lib/ai";
import { messageDate } from "~/lib/format";
import { bodyArrivedForSummary, dismissSummary, loadSummary, revealSummaryMessage, setSummaryOpen, stopSummary, summarizable, summarize, useSummaries } from "~/lib/summaries";
import { replyFromItem } from "~/lib/summary-reply";
import { setApp, useApp } from "~/state/app";
import { useAiLook } from "~/lib/ai-look";
import { AI_LOOK_SPECS, type AiLookSpec } from "./ai-looks";
import { AI_ACTIONS, AiCopyButton, AiErrorNotice, AiProvenance, aiErrorCopy, errorTarget, messageSource, messageSourceShort } from "./ai-card";

/** Pass 3: what an item asks of the user, answered with the conversation's ordinary reply. */
const ANSWERED = new Set<AiSummaryItem["kind"]>(["action", "question"]);

/**
 * "To do · Tell Arjun what you think", and under the words, at their edge, what can be done with it. Plan 162 (after
 * ai162-r01): one left edge, the paragraph's: the kind is a muted word before the item, not a column of its own (the item
 * started 47 px in from the text above it), and the item is medium, the card's second read. Reply drafts from it: the
 * reply opens with ⌘J's row holding the item as its instruction (it opened a blank reply, and the suggestion was lost).
 * On a conversation of one message, that message is the one on screen: no source.
 */
/**
 * Plan 162 (after ai162-r03): what an item is, in words: a question is someone's ("Arjun asks"), from the message it cites;
 * a to-do is the reader's. "Question" read as an instruction beside "Share your thoughts on…".
 */
export function itemLabel(item: Pick<AiSummaryItem, "kind">, from: Pick<MessageDetail, "from"> | undefined, mine: readonly string[]): string {
  if (item.kind !== "question" || !from || mine.some((e) => e.toLowerCase() === from.from.email.toLowerCase())) return t(`summary.kind.${item.kind}`);
  const name = (from.from.name || from.from.email.split("@")[0] || "").split(/\s+/)[0];
  return name ? t("summary.kind.asks", { name }) : t("summary.kind.question");
}

/** exploration (ai-looks, Edge light): each kind's glyph in place of its word */
const KIND_GLYPH: Record<AiSummaryItem["kind"], typeof Sparkles> = { date: CalendarDays, action: ListChecks, question: MessageSquareText, decision: BadgeCheck };

function Item({ item, from, source, short, mine, facts = "inline" }: { item: AiSummaryItem; from: MessageDetail | undefined; source: string | null; /** the date alone, when the label names the person */ short: string | null; mine: readonly string[]; facts?: AiLookSpec["items"] }) {
  const label = itemLabel(item, from, mine);
  // plan 162 (after ai162-r05): "Arjun asks · …  Reply  Yesterday, 8:24 AM →": the label already says whose it is
  // (with a glyph for the kind, no name is on the line, so the source says whose)
  const named = facts !== "glyphs" && short !== null && label !== t(`summary.kind.${item.kind}`);
  const go = source !== null && (
    <Button variant="ghost" size="sm" data-testid="summary-item-open" aria-label={source} className="px-2 text-muted-foreground hover:text-foreground" onClick={() => revealSummaryMessage(item.messageId)}>
      {named ? short : source}
      <ArrowRight aria-hidden />
    </Button>
  );
  const answered = ANSWERED.has(item.kind);
  return (
    // plan 162 (after ai162-r05): the controls end the item's own line when they fit, and wrap under its words, at their
    // edge, when they don't (a line of their own under every item took half the reader at 1100: three reports)
    <li data-testid="summary-item" data-kind={item.kind} data-message-id={item.messageId} className={LI[facts]}>
      {/* exploration (ai-looks, Float): the kind a small label over its words */}
      {facts === "stacked" && <span className="text-xs text-muted-foreground" data-testid="summary-item-kind">{label}</span>}
      <div className={facts === "stacked" ? "flex flex-wrap items-center gap-x-3" : "contents"}>
      <p className="min-w-0 wrap-anywhere" data-testid="summary-item-text">
        {facts === "glyphs" && (() => {
          // exploration (ai-looks, Edge light): the kind's glyph on the words' first line, its word for screen readers
          const Glyph = KIND_GLYPH[item.kind];
          return <><Glyph aria-hidden className="me-2 inline size-[1.15em] align-[-0.2em] text-muted-foreground" /><span className="sr-only" data-testid="summary-item-kind">{`${label}: `}</span></>;
        })()}
        {(facts === "inline" || facts === "ruled") && (
          <>
            <span className="text-muted-foreground" data-testid="summary-item-kind">{label}</span>
            <span aria-hidden className="mx-1.5 text-muted-foreground">·</span>
          </>
        )}
        <span className="font-medium text-foreground">{item.text}</span>
      </p>
      {(answered || go) && (
        <div className="flex flex-wrap items-center gap-1" data-testid="summary-item-controls">
          {answered && (
            // plan 162 (after ai162-r03): an ordinary reply, as R is: the item is their question, not the user's answer, so it
            // isn't put in ⌘J as the instruction (Write would have drafted a reply with no stance)
            // plan 162 (after ai162-r04): quiet, in the ink, its glyph on the words' edge: two bordered Replies outweighed the
            // summary itself (six reports); it still leads its line, the source after it muted
            <Button variant="ghost" size="sm" data-testid="summary-item-reply" className="-ms-2 px-2 text-foreground" onClick={() => replyFromItem()}>
              <Reply aria-hidden />
              {t("actions.reply")}
            </Button>
          )}
          {go && from ? (
            <Tooltip>
              <TooltipTrigger render={go} />
              <TooltipContent data-testid="summary-item-source" side="bottom" align="start">{`${from.from.name || from.from.email} · ${messageDate(from.date)}`}</TooltipContent>
            </Tooltip>
          ) : go}
        </div>
      )}
      </div>
    </li>
  );
}

/** each facts mode's row: today's line; ruled rows; a label over the words; a glyph before them */
const LI: Record<AiLookSpec["items"], string> = {
  inline: "flex flex-wrap items-center gap-x-3 py-0.5 text-sm",
  ruled: "flex flex-wrap items-center gap-x-3 py-1.5 text-sm",
  stacked: "flex flex-col items-start py-1 text-sm",
  glyphs: "flex flex-wrap items-center gap-x-3 py-0.5 text-sm",
};
const UL: Record<AiLookSpec["items"], string> = {
  inline: "mt-2",
  ruled: "mt-3 hairline-t hairline-divide",
  stacked: "mt-3 flex flex-col gap-1.5",
  glyphs: "mt-2.5 flex flex-col gap-0.5",
};

/** The summary as one text, its items under it, for Copy. */
export function summaryText(summary: Pick<AiSummary, "summary" | "items">): string {
  return [summary.summary.trim(), ...summary.items.map((i) => `${t(`summary.kind.${i.kind}`)}: ${i.text}`)].join("\n");
}

function Ready({ summary, messages, spec }: { summary: AiSummary; messages: readonly MessageDetail[]; spec: AiLookSpec }) {
  const open = useSummaries((s) => s.open);
  const mine = useApp((s) => s.accounts).map((a) => a.email);
  const copy = <AiCopyButton iconOnly={spec.copyIcon} className={spec.tools === "footer" ? "-ms-2" : undefined} text={() => summaryText(summary)} failed={t("summary.copyFailed")} testId="summary-copy" />;
  const provenance = <AiProvenance model={summary.model} at={summary.generatedAt} testId="summary-provenance" className={spec.tools === "footer" ? "-me-1.5 ms-auto" : undefined} />;
  const label = (
    <>
      <Sparkles aria-hidden className={spec.glyph} />
      <span className={spec.title}>{t("summary.label")}</span>
    </>
  );
  return (
    <Collapsible open={open} onOpenChange={setSummaryOpen} data-testid="summary-block" data-state="ready" className={cn(spec.card, spec.after)}>
      {spec.tools === "header" ? (
        // exploration (ai-looks): Copy and who wrote it at the header's end, the chevron beside the name it opens
        <div className={cn("flex items-center gap-2", spec.inset)}>
          <CollapsibleTrigger data-testid="summary-toggle" className={cn(spec.trigger, "w-auto gap-1.5 rounded-sm px-0 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&_[data-slot=collapsible-chevron]]:ms-0")}>
            {label}
          </CollapsibleTrigger>
          <div className="-me-1.5 ms-auto flex items-center gap-0.5">
            {provenance}
            {copy}
          </div>
        </div>
      ) : (
        <CollapsibleTrigger data-testid="summary-toggle" className={cn(spec.trigger, "gap-1.5 rounded-[inherit] text-sm font-medium text-muted-foreground transition-colors hover:text-foreground")}>
          {label}
        </CollapsibleTrigger>
      )}
      {/* plan 162 (after ai162-r04): closing, the words fade as the card closes, so no half-cut line shows on the way */}
      <CollapsiblePanel className="mx-0 px-0 transition-[height,opacity] data-ending-style:opacity-0 data-starting-style:opacity-0">
        {/* the padding inside the panel: a padded panel can't ease down to 0 */}
        <div className={cn(spec.inset, spec.bottom)}>
          {/* plain text, never HTML: a model's markup has no way in. Plan 162: the card's width (the measure left a dead column) */}
          <p data-testid="summary-text" className="max-w-(--read-max) text-sm leading-relaxed wrap-anywhere whitespace-pre-line text-pretty">
            {summary.summary}
          </p>
          {summary.items.length > 0 && <ul className={cn(UL[spec.items], spec.items !== "ruled" && "max-w-(--read-max)")} data-testid="summary-items">{summary.items.map((item) => <Item key={`${item.messageId}:${item.kind}:${item.text}`} item={item} mine={mine} facts={spec.items} from={messages.find((m) => m.id === item.messageId)} source={messageSource(messages, item.messageId, mine)} short={messageSourceShort(messages, item.messageId)} />)}</ul>}
          {/* pass 3: the AI's button row: Copy, and who wrote it at its end, the one control every AI surface has */}
          {spec.tools === "footer" && (
            <div className={cn(AI_ACTIONS, "mt-1.5")} data-testid="summary-actions">
              {/* plan 162: Copy is quiet, its glyph on the text's edge */}
              {copy}
              {provenance}
            </div>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The card's other states, its header's size: what's happening, and what the user can do about it. */
function Line({ spec, state, status, icon, actions, children }: { spec: AiLookSpec; state: string; status?: boolean; icon?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div data-testid="summary-block" data-state={state} role={status ? "status" : undefined} className={cn(spec.card, spec.after, spec.inset, "flex min-h-10 items-start gap-1.5 py-2.5 text-sm text-muted-foreground")}>
      {/* on the first line, however many the text takes */}
      <span className="flex h-[1lh] shrink-0 items-center">{icon ?? <Sparkles aria-hidden className={spec.glyph} />}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
        {/* its own width: a short status keeps its action on the row, and a long one sends it below */}
        <span className="min-w-0 flex-auto wrap-anywhere">{children}</span>
        {/* the 28 px buttons (plan 161: the AI suggestions' one height) reach 4 px past the 20 px line, as the header's height holds them */}
        {actions && <span className="-my-1 ms-auto flex shrink-0 items-center gap-1.5 text-foreground">{actions}</span>}
      </div>
    </div>
  );
}

const openSettings = () => setApp({ dialog: "settings", settingsTab: "ai" });

/**
 * Plan 132 §6 and plan 148: a thread's summary, on a card between the header and the conversation, so it never reads
 * as part of the mail. It appears only when there's something to say; nothing for pending or failed (Settings says
 * why), and nothing in spam or trash.
 */
export default function ThreadSummary({ detail }: { detail: ThreadDetail }) {
  const threadId = detail.thread.id;
  const ui = useSummaries((s) => s.byThread.get(threadId));
  const ai = useApp((s) => s.settings?.ai);
  const spec = AI_LOOK_SPECS[useAiLook()];
  // any change of the messages or their bodies may change what the backend can show
  const sources = detail.messages.map((m) => `${m.id}:${m.bodyState}`).join(",");
  useEffect(() => {
    void loadSummary(threadId);
    bodyArrivedForSummary(threadId);
  }, [threadId, sources]);
  // Stop goes away with the state it's in: focus stays with the block (its next control), or when that went too, the
  // toolbar's button that started it; never on the page. Only while it's really here: a click away blurs with no
  // relatedTarget, just as a removed control does, so a later change must not pull focus back from wherever the user went.
  const block = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!block.current?.contains(e.target as Node)) hadFocus.current = false;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  useLayoutEffect(() => {
    if (!hadFocus.current || document.activeElement !== document.body) return;
    hadFocus.current = false;
    const next = block.current?.querySelector<HTMLElement>("button") ?? document.querySelector<HTMLElement>("[data-summarize]");
    next?.focus({ preventScroll: true });
  }, [ui?.kind]);
  if (!summarizable(detail.thread)) return null;
  const onFocusCapture = () => { hadFocus.current = true; };
  const onBlurCapture = (e: React.FocusEvent) => { if (e.relatedTarget) hadFocus.current = false; };
  const content = (() => {
    switch (ui?.kind) {
      case "ready":
        return <Ready summary={ui.summary} messages={detail.messages} spec={spec} />;
      case "running":
        return (
          <Line
            spec={spec}
            state="running"
            status
            icon={<Spinner aria-hidden className={spec.glyph} />}
            actions={
              // plan 162 (after ai162-r03): Esc stops it, as it stops ⌘J and Ask, and says so
              <Button size="sm" variant="ghost" data-testid="summary-stop" aria-keyshortcuts="Escape" onClick={() => stopSummary(threadId)}>
                {t("summary.stop")}
                <Shortcut keys="escape" className="ms-0.5" />
              </Button>
            }
          >
            {t("summary.running")}
          </Line>
        );
      case "waitingBody":
        return (
          <Line spec={spec} state="waiting" status>
            {t("summary.downloading")}
          </Line>
        );
      case "noProvider":
        return (
          <Line
            spec={spec}
            state="no-provider"
            actions={
              <Button size="sm" variant="outline" data-testid="summary-settings" onClick={() => { dismissSummary(threadId); openSettings(); }}>
                {t("common.settings")}
              </Button>
            }
          >
            {t("summary.noProvider")}
          </Line>
        );
      case "error": {
        // plan 161, pass 2: the one AI error (ai-card): plain words, never an address, Try again and AI settings
        // the summary's own provider (a task choice, or OpenAI's default), not always Settings' first row (Codex review)
        const target = ai ? routeOf("summary", ai) : null;
        const copy = aiErrorCopy({ message: ui.message, kind: ui.errorKind, key: ui.key }, target && target.provider !== "none" ? errorTarget(target.provider, ai) : null);
        return (
          <div data-testid="summary-block" data-state="error" className={cn(spec.card, spec.after, spec.inset, "flex min-h-10 py-2.5")}>
            <AiErrorNotice
              copy={copy}
              textTestId="summary-error"
              actions={
                <span className="-my-1 flex items-center gap-1.5">
                  <Button size="sm" variant="outline" data-testid="summary-retry" onClick={() => { dismissSummary(threadId); void summarize(threadId); }}>
                    {t("summary.tryAgain")}
                  </Button>
                  {copy.settings && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" data-testid="summary-error-settings" onClick={() => { dismissSummary(threadId); openSettings(); }}>
                      {t("ai.error.settings")}
                    </Button>
                  )}
                </span>
              }
            />
          </div>
        );
      }
      default:
        return null;
    }
  })();
  if (!content) return null;
  return <div ref={block} data-summary-card onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>{content}</div>;
}
