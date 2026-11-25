import type { AiSummary, AiSummaryItem, MessageDetail, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, Reply } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { routeOf } from "~/lib/ai";
import { repeatsItem } from "~/lib/reader-items";
import { calendarDay, messageDate } from "~/lib/format";
import { bodyArrivedForSummary, dismissSummary, loadSummary, revealSummaryMessage, setSummaryOpen, stopSummary, summarizable, summarize, useSummaries } from "~/lib/summaries";
import { replyFromItem } from "~/lib/summary-reply";
import { useApp } from "~/state/app";
import { openSettings } from "~/lib/settings-place";
import { announce } from "~/lib/announce";
import { AI_CARD, AI_GLYPH, AI_HEADER, AI_INSET, AI_PAD, AI_TITLE, AiCopyButton, AiErrorNotice, AiProvenance, aiErrorCopy, errorTarget, messageSource, messageSourceShort } from "./ai-card";

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

function Item({ item, from, source, short, mine }: { item: AiSummaryItem; from: MessageDetail | undefined; source: string | null; /** the date alone, when the label names the person */ short: string | null; mine: readonly string[] }) {
  const label = itemLabel(item, from, mine);
  // plan 162 (after ai162-r05): "Arjun asks · …  Reply  Yesterday, 8:24 AM →": the label already says whose it is
  const named = short !== null && label !== t(`summary.kind.${item.kind}`);
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
    <li data-testid="summary-item" data-kind={item.kind} data-message-id={item.messageId} className="flex flex-wrap items-center gap-x-3 py-0.5 text-sm">
      <p className="min-w-0 wrap-anywhere" data-testid="summary-item-text">
        <span className="text-muted-foreground" data-testid="summary-item-kind">{label}</span>
        <span aria-hidden className="mx-1.5 text-muted-foreground">·</span>
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
    </li>
  );
}

/** plan 181: 20 px before the conversation */
const CARD = `${AI_CARD} mb-5`;
const GLYPH = AI_GLYPH;

/** The summary as one text, its items under it, for Copy. */
export function summaryText(summary: Pick<AiSummary, "summary" | "items">): string {
  return [summary.summary.trim(), ...summary.items.map((i) => `${t(`summary.kind.${i.kind}`)}: ${i.text}`)].join("\n");
}

/** Plan 210 (iteration 3, Codex revision 10): what it asks of you that the reader's line already says isn't said twice. */
const ASKED = new Set<AiSummaryItem["kind"]>(["action"]);

/**
 * Plan 279 (the owner: "list first only"): with a since, the rows citing a message from where it starts come first, each
 * group in its own order; no word or mark says so. The rows are the whole conversation's in both views, and don't move.
 */
export function newFirst<I extends Pick<AiSummaryItem, "messageId">>(items: readonly I[], messages: readonly Pick<MessageDetail, "id">[], from: number | null): I[] {
  const start = from === null ? -1 : messages.findIndex((m) => m.id === from);
  if (start < 0) return [...items];
  const isNew = (i: I) => messages.findIndex((m) => m.id === i.messageId) >= start;
  return [...items.filter(isNew), ...items.filter((i) => !isNew(i))];
}

/** Plan 279: the since's control, worded by its first message's calendar day ("Since Nov 3", "Since yesterday"). */
function sinceLabel(at: number): string {
  const day = calendarDay(at);
  return "date" in day ? t("summary.view.since", { date: day.date }) : t(day.day === "today" ? "summary.view.sinceToday" : "summary.view.sinceYesterday");
}

type View = "since" | "whole";

function Ready({ summary, messages, said }: { summary: AiSummary; messages: readonly MessageDetail[]; said: readonly string[] }) {
  const open = useSummaries((s) => s.open);
  const mine = useApp((s) => s.accounts).map((a) => a.email);
  // plan 279: where the new mail starts, while that message is here (trashed since, it isn't: Codex code review 7)
  const start = summary.since ? messages.find((m) => m.id === summary.since!.from && !m.isTrash && !m.isSpam) : undefined;
  // what's new opens first, every time (the choice isn't kept), and again when a newer summary replaces this one: held
  // with the summary it was made for, so nothing remounts under the keyboard (Codex code review 9)
  const [view, setView] = useState<{ at: number; view: View }>({ at: summary.generatedAt, view: "since" });
  // an empty text still puts the new mail's rows first (Codex code review 5); only a text gets its view
  const since = start && summary.since?.text ? summary.since : null;
  const chosen: View = since ? (view.at === summary.generatedAt ? view.view : "since") : "whole";
  const text = chosen === "since" && since ? since.text : summary.summary;
  const all = newFirst(summary.items, messages, start ? start.id : null);
  // in this view only: the summary itself (and Copy) keeps every item
  const items = all.filter((i) => !ASKED.has(i.kind) || !repeatsItem(i.text, said));
  return (
    <Collapsible open={open} onOpenChange={setSummaryOpen} data-testid="summary-block" data-state="ready" className={CARD}>
      {/* plan 181: one row, open or closed: the name (its chevron beside it, the trigger as wide as its words), then who
          wrote it and Copy at its end, where a footer row of their own used to be */}
      <div className={cn(AI_HEADER, AI_INSET, "py-0")}>
        <CollapsibleTrigger data-testid="summary-toggle" className="h-11 w-auto gap-2 rounded-sm px-0 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&_[data-slot=collapsible-chevron]]:ms-0">
          <span className={AI_TITLE}>{t("summary.label")}</span>
        </CollapsibleTrigger>
        <div className="-me-1.5 ms-auto flex items-center gap-0.5" data-testid="summary-tools">
          <AiProvenance model={summary.model} at={summary.generatedAt} testId="summary-provenance" />
          {/* plan 162: Copy is quiet; plan 181: its glyph alone, named, with a tooltip */}
          {/* plan 279: what's on screen, its paragraph and every row */}
          <AiCopyButton iconOnly text={() => summaryText({ summary: text, items: all })} failed={t("summary.copyFailed")} testId="summary-copy" />
        </div>
      </div>
      {/* plan 162 (after ai162-r04): closing, the words fade as the card closes, so no half-cut line shows on the way */}
      <CollapsiblePanel className="mx-0 px-0 transition-[height,opacity] data-ending-style:opacity-0 data-starting-style:opacity-0">
        {/* the padding inside the panel: a padded panel can't ease down to 0 */}
        <div className={AI_PAD}>
          {/* plan 279 (Codex and Fable reviews): the panel's first line, on the paragraph's edge, not the header (two labels
              don't fit beside the title, Copy and who wrote it); it closes with the card. Swapped in place: the rows stay */}
          {since && start && (
            <ToggleGroup aria-label={t("summary.view")} variant="segmented" size="sm" value={[chosen]} onValueChange={(v: string[]) => v[0] && setView({ at: summary.generatedAt, view: v[0] as View })} className="mb-2 max-w-full" data-testid="summary-view">
              <ToggleGroupItem value="since" data-testid="summary-view-since" className="min-w-0 px-2.5 text-xs">
                {sinceLabel(start.date)}
              </ToggleGroupItem>
              <ToggleGroupItem value="whole" data-testid="summary-view-whole" className="min-w-0 px-2.5 text-xs">
                {t("summary.view.whole")}
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          {/* plain text, never HTML: a model's markup has no way in. Plan 162: the card's width (the measure left a dead column) */}
          <p data-testid="summary-text" data-view={chosen} className="max-w-(--read-max) text-sm leading-relaxed wrap-anywhere whitespace-pre-line text-pretty">
            {text}
          </p>
          {items.length > 0 && <ul className="mt-2 max-w-(--read-max)" data-testid="summary-items">{items.map((item) => <Item key={`${item.messageId}:${item.kind}:${item.text}`} item={item} mine={mine} from={messages.find((m) => m.id === item.messageId)} source={messageSource(messages, item.messageId, mine)} short={messageSourceShort(messages, item.messageId)} />)}</ul>}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The card's other states, its header's size: what's happening, and what the user can do about it. */
function Line({ state, status, icon, actions, children }: { state: string; status?: boolean; icon?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div data-testid="summary-block" data-state={state} role={status ? "status" : undefined} className={cn(CARD, AI_INSET, "flex min-h-11 items-start gap-2 py-3 text-sm text-muted-foreground")}>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
        {/* its own width: a short status keeps its action on the row, and a long one sends it below. Plan 181 (the owner): no
            mark; a working card's spinner follows its words, so they start where the summary's title will (Codex review) */}
        <span className="min-w-0 flex-auto wrap-anywhere">
          {children}
          {icon && <span className="ms-2 inline-flex align-[-0.2em]">{icon}</span>}
        </span>
        {/* the 28 px buttons (plan 161: the AI suggestions' one height) reach 4 px past the 20 px line, as the header's height holds them */}
        {actions && <span className="-my-1 ms-auto flex shrink-0 items-center gap-1.5 text-foreground">{actions}</span>}
      </div>
    </div>
  );
}

const openAiSettings = () => openSettings("ai");

/**
 * Plan 132 §6 and plan 148: a thread's summary, on a card between the header and the conversation, so it never reads
 * as part of the mail. It appears only when there's something to say; nothing for pending or failed (Settings says
 * why), and nothing in spam or trash.
 */
export default function ThreadSummary({ detail, said = [] }: { detail: ThreadDetail; /** what the reader's line already says (plan 210, iteration 3) */ said?: readonly string[] }) {
  const threadId = detail.thread.id;
  const ui = useSummaries((s) => s.byThread.get(threadId));
  const ai = useApp((s) => s.settings?.ai);
  // any change of the messages or their bodies may change what the backend can show
  // (plan 279: and whether each is in the trash: a trashed message changes what's shown, a since's start among them)
  const sources = detail.messages.map((m) => `${m.id}:${m.bodyState}:${m.isTrash ? 1 : 0}`).join(",");
  useEffect(() => {
    void loadSummary(threadId);
    bodyArrivedForSummary(threadId);
  }, [threadId, sources]);
  // Stop goes away with the state it's in: focus stays with the block (its next control), or when that went too, the
  // toolbar's button that started it; never on the page. Only while it's really here: a click away blurs with no
  // relatedTarget, just as a removed control does, so a later change must not pull focus back from wherever the user went.
  const block = useRef<HTMLElement>(null);
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
  // plan 188: a summary that was being written and is ready says so, once (never its words as they stream)
  const wasRunning = useRef(false);
  useEffect(() => {
    if (ui?.kind === "ready" && wasRunning.current) announce(t("summary.ready"));
    wasRunning.current = ui?.kind === "running";
  }, [ui?.kind]);
  if (!summarizable(detail.thread)) return null;
  const onFocusCapture = () => { hadFocus.current = true; };
  const onBlurCapture = (e: React.FocusEvent) => { if (e.relatedTarget) hadFocus.current = false; };
  const content = (() => {
    switch (ui?.kind) {
      case "ready":
        return <Ready summary={ui.summary} messages={detail.messages} said={said} />;
      case "running":
        return (
          <Line
            state="running"
            status
            icon={<Spinner aria-hidden className={GLYPH} />}
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
          <Line state="waiting" status>
            {t("summary.downloading")}
          </Line>
        );
      case "noProvider":
        return (
          <Line
            state="no-provider"
            actions={
              <Button size="sm" variant="outline" data-testid="summary-settings" onClick={() => { dismissSummary(threadId); openAiSettings(); }}>
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
          <div data-testid="summary-block" data-state="error" className={cn(CARD, AI_INSET, "flex min-h-11 py-3")}>
            <AiErrorNotice
              copy={copy}
              textTestId="summary-error"
              actions={
                <span className="-my-1 flex items-center gap-1.5">
                  <Button size="sm" variant="outline" data-testid="summary-retry" onClick={() => { dismissSummary(threadId); void summarize(threadId, { again: ui.again }); }}>
                    {t("summary.tryAgain")}
                  </Button>
                  {copy.settings && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" data-testid="summary-error-settings" onClick={() => { dismissSummary(threadId); openAiSettings(); }}>
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
  // plan 188: a region named Summary, as Reply ready and the follow-ups are, so the rotor finds it
  return <section ref={block} aria-label={t("summary.label")} data-summary-card onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>{content}</section>;
}
