import type { AiSummary, AiSummaryItem, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useRef } from "react";
import { errorHelp, modelName, providerLabel } from "~/lib/ai";
import { fullDate } from "~/lib/format";
import { bodyArrivedForSummary, dismissSummary, loadSummary, revealSummaryMessage, setSummaryOpen, stopSummary, summarizable, summarize, useSummaries } from "~/lib/summaries";
import { setApp, useApp } from "~/state/app";

/** "Action   Send the signed contract   →": the arrow's whole row goes to the message that says it. */
function Item({ item }: { item: AiSummaryItem }) {
  return (
    <li>
      <button
        type="button"
        data-testid="summary-item"
        data-kind={item.kind}
        data-message-id={item.messageId}
        onClick={() => revealSummaryMessage(item.messageId)}
        className="group/item -mx-2 flex min-h-7 w-[calc(100%+1rem)] items-baseline gap-3 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-field focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="w-[4.5rem] shrink-0 text-xs text-muted-foreground">{t(`summary.kind.${item.kind}`)}</span>
        <span className="min-w-0 flex-1 wrap-anywhere">{item.text}</span>
        <span className="sr-only">{t("summary.goTo")}</span>
        {/* on the first line, however many the text takes */}
        <span aria-hidden className="flex h-[1lh] shrink-0 items-center self-start">
          <ArrowRight className="size-[1.15em] text-muted-foreground transition-colors group-hover/item:text-foreground" />
        </span>
      </button>
    </li>
  );
}

/** A model's words, not the sender's: the design's card, its edges on the conversation's column and its text inset. */
const CARD = "card-group mb-4";
const GLYPH = "size-[1.15em] shrink-0 text-muted-foreground";

function Ready({ summary }: { summary: AiSummary }) {
  const open = useSummaries((s) => s.open);
  const provenance = t("summary.provenance", { model: modelName(summary.model), date: fullDate(summary.generatedAt) });
  return (
    <Collapsible open={open} onOpenChange={setSummaryOpen} data-testid="summary-block" data-state="ready" className={CARD}>
      <Tooltip>
        <TooltipTrigger
          render={
            <CollapsibleTrigger data-testid="summary-toggle" className="h-10 gap-1.5 rounded-[inherit] px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              <Sparkles aria-hidden className={GLYPH} />
              {t("summary.label")}
            </CollapsibleTrigger>
          }
        />
        <TooltipContent data-testid="summary-provenance" side="top" align="start">
          {provenance}
        </TooltipContent>
      </Tooltip>
      <CollapsiblePanel className="mx-0 px-0">
        {/* the padding inside the panel: a padded panel can't ease down to 0 */}
        <div className="px-3.5 pb-3">
          {/* plain text, never HTML: a model's markup has no way in */}
          <p data-testid="summary-text" className="text-sm wrap-anywhere whitespace-pre-line text-pretty">
            {summary.summary}
          </p>
          {summary.items.length > 0 && <ul className="mt-1.5" data-testid="summary-items">{summary.items.map((item) => <Item key={`${item.messageId}:${item.kind}:${item.text}`} item={item} />)}</ul>}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The card's other states, its header's size: what's happening, and what the user can do about it. */
function Line({ state, status, icon, actions, children }: { state: string; status?: boolean; icon?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div data-testid="summary-block" data-state={state} role={status ? "status" : undefined} className={cn(CARD, "flex min-h-10 items-start gap-1.5 px-3.5 py-2.5 text-sm text-muted-foreground")}>
      {/* on the first line, however many the text takes */}
      <span className="flex h-[1lh] shrink-0 items-center">{icon ?? <Sparkles aria-hidden className={GLYPH} />}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
        {/* its own width: a short status keeps its action on the row, and a long one sends it below */}
        <span className="min-w-0 flex-auto wrap-anywhere">{children}</span>
        {/* the 24 px buttons reach 2 px past the 20 px line, as the header's height holds them */}
        {actions && <span className="-my-0.5 ms-auto flex shrink-0 items-center gap-1.5">{actions}</span>}
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
        return <Ready summary={ui.summary} />;
      case "running":
        return (
          <Line
            state="running"
            status
            icon={<Spinner aria-hidden className={GLYPH} />}
            actions={
              <Button size="xs" variant="ghost" data-testid="summary-stop" onClick={() => stopSummary(threadId)}>
                {t("summary.stop")}
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
      case "consent":
        return (
          <Line
            state="consent"
            actions={
              <>
                <Button size="xs" variant="ghost" data-testid="summary-settings" onClick={openSettings}>
                  {t("common.settings")}
                </Button>
                <Button size="xs" variant="outline" data-testid="summary-continue" onClick={() => { dismissSummary(threadId); void summarize(threadId, { acknowledge: true }); }}>
                  {t("common.continue")}
                </Button>
              </>
            }
          >
            <span data-testid="summary-consent">{t("summary.consent", { provider: providerLabel(ui.provider, ai) })}</span>
          </Line>
        );
      case "noProvider":
        return (
          <Line
            state="no-provider"
            actions={
              <Button size="xs" variant="outline" data-testid="summary-settings" onClick={() => { dismissSummary(threadId); openSettings(); }}>
                {t("common.settings")}
              </Button>
            }
          >
            {t("summary.noProvider")}
          </Line>
        );
      case "error": {
        const help = ai ? errorHelp(ui.errorKind, ai) : null;
        return (
          <Line
            state="error"
            actions={
              <Button size="xs" variant="ghost" data-testid="summary-retry" onClick={() => { dismissSummary(threadId); void summarize(threadId); }}>
                {t("summary.tryAgain")}
              </Button>
            }
          >
            <span role="alert" data-testid="summary-error">
              <span className="text-foreground">{ui.message}</span>
              {help ? ` ${help}` : ""}
            </span>
          </Line>
        );
      }
      default:
        return null;
    }
  })();
  if (!content) return null;
  return <div ref={block} onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>{content}</div>;
}
