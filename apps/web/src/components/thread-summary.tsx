import type { AiSummary, AiSummaryItem, MessageDetail, ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ArrowRight, Sparkles } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useRef } from "react";
import { providerLabel, summaryTarget } from "~/lib/ai";
import { messageDate } from "~/lib/format";
import { provenanceDetail, provenanceLabel } from "~/lib/provenance";
import { snack } from "~/lib/snack";
import { bodyArrivedForSummary, dismissSummary, loadSummary, revealSummaryMessage, setSummaryOpen, stopSummary, summarizable, summarize, useSummaries } from "~/lib/summaries";
import { setApp, useApp } from "~/state/app";
import { AI_CARD, AI_GLYPH, AI_TITLE, AiErrorNotice, aiErrorCopy, errorTarget, messageSource } from "./ai-card";

/**
 * "Action · Send the signed contract      Arjun · Oct 21 →": the row goes to the message that says it, and says whose and
 * when (plan 161, pass 2: "Open message" didn't say which). On a conversation of one message, that message is the one on
 * screen: the row is plain text. Its name is its visible words, in order (axe's label-content-name-mismatch).
 */
function Item({ item, from, source }: { item: AiSummaryItem; from: MessageDetail | undefined; source: string | null }) {
  const kind = t(`summary.kind.${item.kind}`);
  if (source === null) {
    return (
      <li data-testid="summary-item" data-kind={item.kind} data-message-id={item.messageId} className="flex min-h-8 items-baseline gap-2 py-1.5 text-sm">
        <span className="shrink-0 text-xs text-muted-foreground">{kind}</span>
        <span className="min-w-0 flex-1 wrap-anywhere">{item.text}</span>
      </li>
    );
  }
  const button = (
    <button
      type="button"
      data-testid="summary-item"
      data-kind={item.kind}
      data-message-id={item.messageId}
      onClick={() => revealSummaryMessage(item.messageId)}
      className="group/item -mx-2 flex min-h-8 w-[calc(100%+1rem)] items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-field focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="shrink-0 text-xs text-muted-foreground">{kind}</span>
      <span className="min-w-0 flex-1 wrap-anywhere">{item.text}</span>
      {/* on the first line, however many the text takes */}
      <span data-testid="summary-item-open" className="flex h-[1lh] shrink-0 items-center gap-1 self-start text-xs text-muted-foreground transition-colors group-hover/item:text-foreground">
        {source}
        <ArrowRight aria-hidden className="size-[1.15em]" />
      </span>
    </button>
  );
  return (
    <li>
      {from ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent data-testid="summary-item-source" side="bottom" align="end">{`${from.from.name || from.from.email} · ${messageDate(from.date)}`}</TooltipContent>
        </Tooltip>
      ) : button}
    </li>
  );
}

const CARD = `${AI_CARD} mb-4`;
const GLYPH = AI_GLYPH;

/** The summary as one text, its items under it, for Copy. */
export function summaryText(summary: Pick<AiSummary, "summary" | "items">): string {
  return [summary.summary.trim(), ...summary.items.map((i) => `${t(`summary.kind.${i.kind}`)}: ${i.text}`)].join("\n");
}

async function copySummary(summary: AiSummary): Promise<void> {
  try {
    await navigator.clipboard.writeText(summaryText(summary));
    snack.success(t("summary.copied"));
  } catch {
    snack.error(t("summary.copyFailed"));
  }
}

function Ready({ summary, messages }: { summary: AiSummary; messages: readonly MessageDetail[] }) {
  const open = useSummaries((s) => s.open);
  const mine = useApp((s) => s.accounts).map((a) => a.email);
  return (
    <Collapsible open={open} onOpenChange={setSummaryOpen} data-testid="summary-block" data-state="ready" className={CARD}>
      <CollapsibleTrigger data-testid="summary-toggle" className="h-10 gap-1.5 rounded-[inherit] px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <Sparkles aria-hidden className={GLYPH} />
        <span className={AI_TITLE}>{t("summary.label")}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="mx-0 px-0">
        {/* the padding inside the panel: a padded panel can't ease down to 0 */}
        <div className="px-3.5 pb-3">
          {/* plain text, never HTML: a model's markup has no way in */}
          <p data-testid="summary-text" className="text-sm wrap-anywhere whitespace-pre-line text-pretty">
            {summary.summary}
          </p>
          {summary.items.length > 0 && <ul className="mt-1.5" data-testid="summary-items">{summary.items.map((item) => <Item key={`${item.messageId}:${item.kind}:${item.text}`} item={item} from={messages.find((m) => m.id === item.messageId)} source={messageSource(messages, item.messageId, mine)} />)}</ul>}
          {/* plan 161, pass 2: Ask's row: Copy, and who wrote it at the end, the model and when in its tooltip */}
          <div className="-ms-2 mt-1.5 flex items-center gap-0.5 text-xs text-muted-foreground" data-testid="summary-actions">
            <Button variant="ghost" size="xs" className="font-medium text-muted-foreground hover:text-foreground" data-testid="summary-copy" onClick={() => void copySummary(summary)}>
              {t("summary.copy")}
            </Button>
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} data-testid="summary-provenance-label" className="ml-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />}>{provenanceLabel()}</TooltipTrigger>
              <TooltipContent data-testid="summary-provenance" side="top" align="end">
                {provenanceDetail(summary.model, summary.generatedAt)}
              </TooltipContent>
            </Tooltip>
          </div>
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
        return <Ready summary={ui.summary} messages={detail.messages} />;
      case "running":
        return (
          <Line
            state="running"
            status
            icon={<Spinner aria-hidden className={GLYPH} />}
            actions={
              <Button size="sm" variant="ghost" data-testid="summary-stop" onClick={() => stopSummary(threadId)}>
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
                <Button size="sm" variant="ghost" data-testid="summary-settings" onClick={openSettings}>
                  {t("common.settings")}
                </Button>
                <Button size="sm" variant="outline" data-testid="summary-continue" onClick={() => { dismissSummary(threadId); void summarize(threadId, { acknowledge: true }); }}>
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
        const target = ai ? summaryTarget(ai) : null;
        const copy = aiErrorCopy({ message: ui.message, kind: ui.errorKind, key: ui.key }, target && target.state !== "none" ? errorTarget(target.provider, ai) : null);
        return (
          <div data-testid="summary-block" data-state="error" className={cn(CARD, "flex min-h-10 px-3.5 py-2.5")}>
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
  return <div ref={block} onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>{content}</div>;
}
