import { answerWithoutCitations, type AskSourceRef } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CloseButton } from "@terno/ui/components/close-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ChevronDown, ChevronUp, Pin, Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { focusAfterDialog, useAsk, useVisited } from "~/lib/ask";
import { listDate } from "~/lib/format";
import { openPinnedSource, unpinAnswer } from "~/lib/pinned-ask";
import { CARD_GAP, clearPinnedAnswer, pinnedAskPlace, usePinnedAsk, type PinnedAnswer } from "~/lib/pinned-ask-state";
import { focusReading } from "~/lib/pinned-draft";
import { usePinned } from "~/lib/pinned-draft-state";
import { useSnack } from "~/lib/snack";
import { AiCopyButton, AiProvenance } from "./ai-provenance";
import { AnswerText, Armed, Checks, SameName, unlinkedClaims, Visited } from "./ask-page";

/** The last focus request the card answered (an object property: the React Compiler note on module lets). */
const answered = { focus: 0 };

/**
 * Plan 165: an Ask answer pinned at the reading pane's bottom right, kept while its sources are read: the question, the
 * answer and its sources, a click on one opening it in the reader with the card still there. Beside a pinned draft it
 * moves to the draft's left, or above it where the pane is too narrow for both (`pinnedAskPlace`). It publishes how much
 * of the pane's foot it covers, so what reads under it scrolls clear.
 */
export function PinnedAsk() {
  const pinned = usePinnedAsk((s) => s.pinned);
  const chose = usePinnedAsk((s) => s.collapsed);
  const focusSeq = usePinnedAsk((s) => s.focus);
  const draftWidth = usePinned((s) => (s.key ? s.width : 0));
  const draftInset = usePinned((s) => s.inset);
  const draft = draftWidth ? { width: draftWidth, inset: draftInset } : null;
  const snackUp = useSnack((s) => s.inset > 0);
  const cardRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [pane, setPane] = useState({ width: 0, height: 0 });
  const [floor, setFloor] = useState(0);
  // the reader's toolbar stays clear: what's above its scroller (none over a list or a new message)
  const [top, setTop] = useState(0);
  const place = pinnedAskPlace(pane, draft, floor, top);
  const collapsed = chose || place.squeezed;

  // the pane's size, as it changes (no polling)
  useLayoutEffect(() => {
    const el = cardRef.current?.parentElement;
    if (!el) return;
    const measure = () => {
      setPane((was) => (was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight }));
      const scroller = el.querySelector<HTMLElement>("[data-reader-scroller]");
      setTop(scroller ? Math.max(0, Math.round(scroller.getBoundingClientRect().top - el.getBoundingClientRect().top)) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the snack dock, where it would meet the card: the card stands on it (its own lifts included: it's measured)
  const base = pinnedAskPlace(pane, draft, 0);
  useLayoutEffect(() => {
    const el = cardRef.current?.parentElement;
    const dock = snackUp ? el?.querySelector<HTMLElement>(":scope > [data-testid=snack-dock] [data-snack-card]")?.getBoundingClientRect() : undefined;
    if (!el || !dock?.width) return setFloor(0);
    const box = el.getBoundingClientRect();
    const right = box.right - base.right;
    const meets = dock.right + CARD_GAP > right - base.width && dock.left - CARD_GAP < right;
    setFloor(meets ? Math.ceil(box.bottom - dock.top) + CARD_GAP : 0);
  }, [snackUp, base.right, base.width, pane.width, pane.height]);
  // how much of the pane's foot it covers: its offset and its height, for what scrolls under it
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const publish = () => usePinnedAsk.setState({ inset: place.bottom + Math.ceil(card.offsetHeight) + CARD_GAP });
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(card);
    return () => ro.disconnect();
  }, [place.bottom]);
  useEffect(() => () => usePinnedAsk.setState({ inset: 0 }), []);

  // pinned: focus comes here once Ask's dialog has gone (programmatic: no ring), once per request
  useEffect(() => {
    if (answered.focus === focusSeq) return;
    const seq = focusSeq;
    answered.focus = seq;
    focusAfterDialog(() => bodyRef.current ?? toggleRef.current, () => usePinnedAsk.getState().focus === seq && usePinnedAsk.getState().pinned !== null);
  }, [focusSeq]);
  // folded with focus in what folds (its own choice is the toggle's, which keeps it): the header keeps it
  useLayoutEffect(() => {
    if (collapsed && document.activeElement === document.body && cardRef.current?.isConnected) toggleRef.current?.focus({ preventScroll: true });
  }, [collapsed]);

  if (!pinned) return null;
  const { turn } = pinned;
  /** the card going with focus in it: reading goes on where it was */
  const away = (go: () => void) => {
    const had = cardRef.current?.contains(document.activeElement) ?? false;
    go();
    if (had) queueMicrotask(() => focusReading(false));
  };

  return (
    <section
      ref={cardRef}
      aria-labelledby={titleId}
      data-testid="pinned-ask"
      data-where={place.where}
      data-collapsed={collapsed || undefined}
      style={{ right: place.right, bottom: place.bottom, width: place.width, maxHeight: collapsed ? undefined : place.maxHeight }}
      className={cn("absolute z-[6] flex flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-popover animate-in fade-in-0 slide-in-from-bottom-1 duration-base", !pane.width && "invisible")}
      onKeyDown={(e) => {
        // a popup's keys (its menu, its provenance: portaled, React still bubbles them here) aren't the card's
        if (e.key !== "Escape" || e.nativeEvent.isComposing || !e.currentTarget.contains(e.target as Node) || (e.target as Element).closest("[data-popup-open]")) return;
        e.preventDefault();
        e.stopPropagation();
        // Esc leaves the card (it stays pinned): back to the list, or List's page, so j/k read on
        focusReading(false);
      }}
    >
      <div className={cn("flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3.5", !collapsed && "hairline-b")}>
        <Sparkles aria-hidden className="size-[1.15em] shrink-0 text-muted-foreground" />
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium" title={turn.question} data-testid="pinned-ask-title">
          <span className="sr-only">{t("ask.pinnedLabel")}: </span>
          {turn.question}
        </h2>
        <span className="flex shrink-0 items-center gap-0.5">
          <HeaderButton
            ref={toggleRef}
            label={collapsed ? t("ask.pinned.expand") : t("ask.pinned.collapse")}
            tip={place.squeezed ? t("ask.pinned.noRoom") : undefined}
            testId="pinned-ask-toggle"
            expanded={!collapsed}
            disabled={place.squeezed}
            onClick={() => !place.squeezed && usePinnedAsk.setState({ collapsed: !chose })}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </HeaderButton>
          <HeaderButton label={t("ask.unpin")} tip={t("ask.unpinTip")} testId="pinned-ask-unpin" pressed onClick={() => away(() => void unpinAnswer())}>
            <Pin />
          </HeaderButton>
          <CloseButton size="sm" className="ms-1" label={t("ask.pinned.close")} data-testid="pinned-ask-close" onClick={() => away(clearPinnedAnswer)} />
        </span>
      </div>
      {!collapsed && <PinnedBody pinned={pinned} bodyRef={bodyRef} />}
    </section>
  );
}

/** An icon-only control of the card's header, named, with its tooltip (the draft's header buttons' look). */
function HeaderButton({ ref, label, tip, testId, pressed, expanded, disabled, onClick, children }: { ref?: React.Ref<HTMLButtonElement>; label: string; tip?: string; testId: string; pressed?: boolean; expanded?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            aria-expanded={expanded}
            // still reachable, and still saying why (a disabled button is skipped and silent)
            aria-disabled={disabled || undefined}
            data-testid={testId}
            onClick={onClick}
            // open isn't a state to show (the ghost button fills while expanded, as a menu's trigger does): pressed is
            className="text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground unavailable:hover:bg-transparent aria-pressed:bg-muted aria-pressed:text-primary"
          >
            {children}
          </Button>
        }
      />
      <TooltipContent className="max-w-64 flex-col items-start gap-0.5 text-left">
        <span className="font-medium">{label}</span>
        {tip && <span className="text-muted-foreground">{tip}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** The answer, Copy and Written with AI, and its sources: what Ask's dialog shows of it, in the card's width. */
function PinnedBody({ pinned, bodyRef }: { pinned: PinnedAnswer; bodyRef: React.RefObject<HTMLDivElement | null> }) {
  const { turn, conversationId, views } = pinned;
  const open = (source: AskSourceRef) => openPinnedSource(source);
  return (
    <div ref={bodyRef} tabIndex={0} aria-label={t("ask.pinned.answer")} data-testid="pinned-ask-body" className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3.5 pt-2.5 pb-2 outline-none">
      <SameName turn={turn} />
      <AnswerText text={turn.answer ?? ""} sources={turn.sources} queries={turn.queries} unlinked={unlinkedClaims(turn)} conversationId={conversationId} open={open} views={views} />
      <Armed sources={turn.sources} />
      <Checks turn={turn} />
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <AiCopyButton className="-ms-2" text={() => answerWithoutCitations(turn.answer ?? "")} failed={t("ask.copyFailed")} testId="pinned-ask-copy" />
        <AiProvenance model={turn.model ?? ""} at={turn.createdAt} testId="pinned-ask-provenance" className="ml-auto" />
      </div>
      {turn.sources.length > 0 && (
        <section aria-labelledby={`${turn.id}-sources`} className="pt-1" data-testid="pinned-ask-sources">
          <h3 id={`${turn.id}-sources`} className="pb-1 text-xs font-medium text-muted-foreground">{t("ask.sourcesCount", { count: turn.sources.length })}</h3>
          {/* -mx-2: the rows' words on the answer's edge, their shapes reaching past it */}
          <ul className="-mx-2 flex flex-col gap-0.5">
            {turn.sources.map((source, i) => (
              <li key={source.messageId}>
                <SourceButton source={source} n={i + 1} conversationId={conversationId} fallback={views[source.messageId]?.state} onOpen={() => open(source)} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A source on the card: its number, sender, subject (or where it went) and date, and whether it's been read. */
function SourceButton({ source, n, conversationId, fallback, onOpen }: { source: AskSourceRef; n: number; conversationId: number; fallback: string | undefined; onOpen: () => void }) {
  const view = useAsk((s) => s.sources[source.messageId]?.state) ?? fallback ?? "ok";
  const armed = useAsk((s) => s.armedSource === source.messageId);
  const visited = useVisited(conversationId, source.messageId);
  const moved = view === "spam" || view === "trash";
  return (
    <button type="button" data-testid="pinned-ask-source" data-visited={visited || undefined} disabled={view === "gone"} onClick={onOpen} className="flex h-8 w-full items-center gap-2 rounded-(--command-radius) px-2 text-start text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground">
      <span className="w-5 shrink-0"><span className="inline-grid h-[1.4em] min-w-[1.4em] place-items-center rounded-[0.4em] bg-field px-[0.3em] text-2xs leading-none font-semibold text-foreground tabular">{n}</span></span>
      <span className={cn("max-w-28 shrink-0 truncate", visited && "text-muted-foreground")} title={source.fromName || source.fromEmail}>{source.fromName || source.fromEmail}</span>
      <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">{view === "gone" ? t("ask.source.gone") : moved ? t(armed ? "ask.source.pressAgain" : view === "spam" ? "ask.source.spam" : "ask.source.trash") : source.subject}</span>
      <span className="shrink-0 text-xs font-normal text-muted-foreground tabular">{listDate(source.date)}</span>
      <Visited visited={visited} />
    </button>
  );
}
