import type { AiSummary, AiSummaryItem, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight } from "@terno/ui/icons";
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
        className="group/item -mx-2 flex min-h-7 w-[calc(100%+1rem)] items-baseline gap-3 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-tint focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="w-[4.5rem] shrink-0 text-xs text-muted-foreground">{t(`summary.kind.${item.kind}`)}</span>
        <span className="min-w-0 flex-1">{item.text}</span>
        <span className="sr-only">{t("summary.goTo")}</span>
        {/* on the first line, however many the text takes */}
        <span aria-hidden className="flex h-[1lh] shrink-0 items-center self-start">
          <ArrowRight className="size-[1.15em] text-muted-foreground transition-colors group-hover/item:text-foreground" />
        </span>
      </button>
    </li>
  );
}

function Ready({ summary }: { summary: AiSummary }) {
  const open = useSummaries((s) => s.open);
  const provenance = t("summary.provenance", { model: modelName(summary.model), date: fullDate(summary.generatedAt) });
  return (
    <Collapsible open={open} onOpenChange={setSummaryOpen} data-testid="summary-block" data-state="ready" className="pb-4">
      <Tooltip>
        <TooltipTrigger
          render={
            <CollapsibleTrigger data-testid="summary-toggle" className="-mx-2 h-7 w-[calc(100%+1rem)] rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              {t("summary.label")}
            </CollapsibleTrigger>
          }
        />
        <TooltipContent data-testid="summary-provenance" side="top" align="start">
          {provenance}
        </TooltipContent>
      </Tooltip>
      <CollapsiblePanel>
        {/* plain text, never HTML: a model's markup has no way in */}
        <p data-testid="summary-text" className="text-sm whitespace-pre-line text-pretty">
          {summary.summary}
        </p>
        {summary.items.length > 0 && <ul className="mt-1.5" data-testid="summary-items">{summary.items.map((item) => <Item key={`${item.messageId}:${item.kind}:${item.text}`} item={item} />)}</ul>}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** One quiet line where the summary will be: what's happening, and what the user can do about it. */
function Line({ state, status, children }: { state: string; status?: boolean; children: React.ReactNode }) {
  return (
    <div data-testid="summary-block" data-state={state} role={status ? "status" : undefined} className="flex min-h-7 flex-wrap items-center gap-x-2 pb-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const openSettings = () => setApp({ dialog: "settings", settingsTab: "ai" });

/**
 * Plan 132 §6: a thread's summary, between the header and the conversation, in the conversation's column. No card or
 * color: type and the hairline the conversation starts with. It appears only when there's something to say; nothing
 * for pending or failed (Settings says why), and nothing in spam or trash.
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
  // Stop goes away with the state it's in: focus stays with the block (its next control), never on the page
  const block = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (!hadFocus.current || document.activeElement !== document.body) return;
    hadFocus.current = false;
    block.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
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
          <Line state="running" status>
            <Spinner aria-hidden className="size-[1.15em] text-muted-foreground" />
            <span>{t("summary.running")}</span>
            <Button size="xs" variant="ghost" data-testid="summary-stop" onClick={() => stopSummary(threadId)}>
              {t("summary.stop")}
            </Button>
          </Line>
        );
      case "waitingBody":
        return (
          <Line state="waiting" status>
            <span>{t("summary.downloading")}</span>
          </Line>
        );
      case "consent":
        return (
          <Line state="consent">
            <span data-testid="summary-consent">{t("summary.consent", { provider: providerLabel(ui.provider, ai) })}</span>
            <Button size="xs" variant="outline" data-testid="summary-continue" onClick={() => { dismissSummary(threadId); void summarize(threadId, { acknowledge: true }); }}>
              {t("common.continue")}
            </Button>
            <Button size="xs" variant="ghost" data-testid="summary-settings" onClick={openSettings}>
              {t("common.settings")}
            </Button>
          </Line>
        );
      case "noProvider":
        return (
          <Line state="no-provider">
            <span>{t("summary.noProvider")}</span>
            <Button size="xs" variant="outline" data-testid="summary-settings" onClick={() => { dismissSummary(threadId); openSettings(); }}>
              {t("common.settings")}
            </Button>
          </Line>
        );
      case "error": {
        const help = ai ? errorHelp(ui.errorKind, ai) : null;
        return (
          <Line state="error">
            <span role="alert" data-testid="summary-error">
              <span className="text-foreground">{ui.message}</span>
              {help ? ` ${help}` : ""}
            </span>
            <Button size="xs" variant="ghost" data-testid="summary-retry" onClick={() => { dismissSummary(threadId); void summarize(threadId); }}>
              {t("summary.tryAgain")}
            </Button>
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
