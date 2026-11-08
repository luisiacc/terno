import { answerWithoutCitations, type AskConversationSummary, type AskSourceRef, type AskTurn } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Chip } from "@terno/ui/components/chip";
import { CommandDescription, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@terno/ui/components/command";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Clock, Mail, Plus, Search, Sparkles, Undo2 } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { askReady, errorHelp, providerLabel } from "~/lib/ai";
import { citationRuns } from "~/lib/ask-citations";
import { provenanceDetail, provenanceLabel } from "~/lib/provenance";
import { cn } from "@terno/ui/lib/utils";
import { askConfigChanged, askQuestion, atTurnLimit, declineConsent, deleteConversation, loadAskHistory, newQuestion, openConversation, openSource, restoreConversation, returning, searchOlder, stopAsking, useAsk } from "~/lib/ask";
import { listDate } from "~/lib/format";
import { askFrom, paletteKeys, setPalettePage } from "~/lib/palette-open";
import { chordLabel } from "@terno/ui/components/shortcut";
import { snack } from "~/lib/snack";
import { useApp, setApp } from "~/state/app";

/** an answer's own buttons: quiet text in a 24 px shape, full ink on hover */
const QUIET = "font-medium text-muted-foreground hover:text-foreground";

const stopKeys = (e: KeyboardEvent) => {
  // a control's own Enter and Space stay out of the list's: cmdk selects the active row whichever control has focus (revision 12)
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
};

/**
 * "…renews on 1 March.¹": a citation is a small numbered marker, a button to that source, bound to the word before it
 * and the punctuation after it (plan 161: no line starts with "."). Its pointer target is 24 px, drawn around it, so the
 * line keeps its rhythm. Everything else stays plain text, never a link.
 */
function AnswerText({ text, sources }: { text: string; sources: readonly AskSourceRef[] }) {
  const views = useAsk((s) => s.sources);
  const marker = (n: number, key: number) => {
    const source = sources[n - 1];
    if (!source || views[source.messageId]?.state === "gone") return <span key={key}>[{n}]</span>;
    return (
      <button key={key} type="button" data-testid="ask-citation" onKeyDown={stopKeys} onClick={() => void openSource(source)} className="relative ms-0.5 inline-grid h-[1.3em] min-w-[1.3em] place-items-center rounded-[0.4em] bg-field px-[0.3em] align-[0.15em] text-2xs leading-none font-semibold text-muted-foreground tabular transition-colors after:absolute after:top-1/2 after:left-1/2 after:size-6 after:-translate-1/2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={t("ask.citation", { n, subject: source.subject })}>
        {n}
      </button>
    );
  };
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="ask-answer">
      {citationRuns(text).map((run, i) =>
        "text" in run ? (
          <span key={i}>{run.text}</span>
        ) : (
          <span key={i} className="whitespace-nowrap" data-testid="ask-cited">
            {run.lead}
            {run.cites.map((n, j) => marker(n, j))}
            {run.trail}
          </span>
        ),
      )}
    </p>
  );
}

function Checks({ turn }: { turn: AskTurn }) {
  const { unlinked, unsupported } = turn.checks;
  if (!unlinked && !unsupported.length) return null;
  return (
    <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground" data-testid="ask-checks">
      {unsupported.map((value) => (
        <p key={value} data-testid="ask-check-unsupported" className="text-destructive-ink">{t("ask.check.unsupported", { value })}</p>
      ))}
      {unlinked && <p data-testid="ask-check-unlinked">{t("ask.check.unlinked")}</p>}
    </div>
  );
}

/** A source asked for once, now in Spam or Trash: said where the citation is, since a row may be further down, or absent. */
function Armed({ sources }: { sources: readonly AskSourceRef[] }) {
  const armed = useAsk((s) => s.armedSource);
  const view = useAsk((s) => (s.armedSource === null ? undefined : s.sources[s.armedSource]));
  if (armed === null || !sources.some((source) => source.messageId === armed)) return null;
  return <p className="text-xs text-muted-foreground" data-testid="ask-source-armed">{t(view?.state === "spam" ? "ask.source.spam" : "ask.source.trash")}. {t("ask.source.pressAgain")}</p>;
}

/** One question and what came of it. */
function Turn({ turn, last, repeated }: { turn: AskTurn; last: boolean; repeated: boolean }) {
  const running = useAsk((s) => s.running !== null);
  if (!turn.answer && !last) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answerWithoutCitations(turn.answer ?? ""));
      snack.success(t("ask.copied"));
    } catch {
      snack.error(t("ask.copyFailed"));
    }
  };
  return (
    <section className="space-y-1.5" data-testid="ask-turn" data-status={turn.status}>
      {/* the header already says it, as does the turn before it when older mail answered again */}
      <h3 className={repeated ? "sr-only" : "text-xs font-medium text-muted-foreground"} data-testid="ask-question">{turn.question}</h3>
      {turn.answer ? <AnswerText text={turn.answer} sources={turn.sources} /> : null}
      <Armed sources={turn.sources} />
      {turn.status === "stopped" && <p className="text-xs text-muted-foreground" data-testid="ask-stopped">{t("ask.stopped")}</p>}
      <Checks turn={turn} />
      {turn.answer && (
        // -ml-2: the buttons' words on the answer's edge; their 24 px shapes reach past it
        <div className="-ml-2 flex items-center gap-0.5 text-xs text-muted-foreground" data-testid="ask-turn-actions">
          <Button variant="ghost" size="xs" className={QUIET} data-testid="ask-copy" onKeyDown={stopKeys} onClick={() => void copy()}>{t("ask.copy")}</Button>
          {last && !running && (
            <Button variant="ghost" size="xs" className={QUIET} data-testid="ask-again" onKeyDown={stopKeys} onClick={() => askQuestion(turn.question)}>{t("ask.again")}</Button>
          )}
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} data-testid="ask-provenance" className="ml-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />}>{provenanceLabel()}</TooltipTrigger>
            <TooltipContent data-testid="ask-provenance-detail">{provenanceDetail(turn.model ?? "", turn.createdAt)}</TooltipContent>
          </Tooltip>
        </div>
      )}
      {last && turn.answer && <Scope />}
    </section>
  );
}

/** Plan 143: what a command came to, in history: the sentence, what it meant, what happened, and doing it again from scratch. */
function CommandTurn({ turn, last }: { turn: AskTurn; last: boolean }) {
  const running = useAsk((s) => s.running !== null);
  return (
    <section className="space-y-1.5" data-testid="ask-turn" data-kind="command">
      <h3 className="text-xs font-medium text-muted-foreground" data-testid="ask-question">{turn.question}</h3>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="ask-command-outcome">{turn.answer}</p>
      {last && !running && <Button variant="link-secondary" size="xs" data-testid="ask-run-again" onKeyDown={stopKeys} onClick={() => askQuestion(turn.question)}>{t("action.runAgain")}</Button>}
    </section>
  );
}

function CommandNotice() {
  const notice = useAsk((s) => s.notice);
  if (!notice) return null;
  return (
    <section className="space-y-1" data-testid="ask-command-notice">
      <h3 className="text-xs font-medium text-muted-foreground" data-testid="ask-question">{notice.question}</h3>
      <p className="text-sm">{notice.text}</p>
    </section>
  );
}

/** Older mail, on a click, when nothing here answers: the main action. An answer has it quietly, in its scope line. */
function Older() {
  const offer = useAsk((s) => s.older);
  const last = useAsk((s) => s.turns.at(-1));
  const found = useAsk((s) => s.olderFound);
  const running = useAsk((s) => s.running !== null);
  const enabled = useApp((s) => s.settings?.ask?.enabled !== false);
  if (!enabled) return null;
  if (found === 0) return <p className="text-sm text-muted-foreground" data-testid="ask-older-nothing">{t("ask.older.nothing")}</p>;
  if (running || !last) return null;
  const main = last.status === "not_found" || last.status === "partial";
  if (!main) return null;
  if (offer.kind === "none") return last.status === "not_found" ? <p className="text-sm text-muted-foreground" data-testid="ask-not-found">{t("ask.notFound")}</p> : null;
  const lead = last.status === "not_found" && <p className="text-sm text-muted-foreground" data-testid="ask-not-found">{"since" in offer && offer.since ? t("ask.notFoundSince", { date: listDate(offer.since) }) : t("ask.notFound")}</p>;
  if (offer.kind === "downloading") return <div className="space-y-1">{lead}<p className="text-xs text-muted-foreground" data-testid="ask-older-downloading">{t("ask.older.downloading")}</p></div>;
  if (offer.kind === "offline") return <div className="space-y-1">{lead}<p className="text-xs text-muted-foreground" data-testid="ask-older-offline">{t("ask.older.offline")}</p></div>;
  return (
    <div className="space-y-1.5">
      {lead}
      <Button size="sm" variant="secondary" data-testid="ask-older" onKeyDown={stopKeys} onClick={searchOlder}>{t("ask.older.button")}</Button>
    </div>
  );
}

/**
 * Plan 161: under an answer, how far back it looked, and the way past that, on one line: what Search older mail adds is
 * said by what it's next to.
 */
function Scope() {
  const offer = useAsk((s) => s.older);
  const last = useAsk((s) => s.turns.at(-1));
  const found = useAsk((s) => s.olderFound);
  const running = useAsk((s) => s.running !== null);
  const enabled = useApp((s) => s.settings?.ask?.enabled !== false);
  if (!enabled || running || !last || last.status === "not_found" || last.status === "partial" || found === 0) return null;
  const since = "since" in offer && offer.since ? offer.since : null;
  if (offer.kind === "none" || offer.kind === "downloading" || !since) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid="ask-scope">
      <span>{t("ask.scope", { date: listDate(since) })}</span>
      {offer.kind === "offline" ? (
        <span data-testid="ask-older-offline">{t("ask.older.offline")}</span>
      ) : (
        // -ml-2 under the gap: its word sits one space after the scope's, its shape reaching back
        <Button variant="ghost" size="xs" className={cn(QUIET, "-ml-2")} data-testid="ask-older" onKeyDown={stopKeys} onClick={searchOlder}>{t("ask.older.servers")}</Button>
      )}
    </p>
  );
}

/** IMAP's search may miss other cases and accents, and a deadline may have left folders out. */
function OlderLimit() {
  const partial = useAsk((s) => s.olderPartial);
  return partial ? <p className="text-xs text-muted-foreground" data-testid="ask-older-partial">{t("ask.older.partial")}</p> : null;
}

function Running() {
  const running = useAsk((s) => s.running);
  const shownTitle = useAsk((s) => s.turns.at(-1)?.question ?? s.turns[0]?.question ?? s.running?.question);
  if (!running) return null;
  const { older, searchingOlder, text, question } = running;
  const looking = searchingOlder && !text ? (older ? t("ask.older.progress", { done: older.done, total: older.total }) : t("ask.older.looking")) : t("ask.looking");
  return (
    <section className="space-y-1.5" data-testid="ask-running">
      <h3 className={question === shownTitle ? "sr-only" : "text-xs font-medium text-muted-foreground"} data-testid="ask-question">{question}</h3>
      {text ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="ask-streaming">{text}</p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-looking">
          <Spinner className="size-3.5" /> {looking}
        </p>
      )}
      <Button variant="link-secondary" size="xs" data-testid="ask-stop" onKeyDown={stopKeys} onClick={() => stopAsking()}>{t("ask.stop")}</Button>
    </section>
  );
}

/** Once a destination: where this goes, before anything leaves. */
function Consent() {
  const consent = useAsk((s) => s.consent);
  const ai = useApp((s) => s.settings?.ai);
  if (!consent) return null;
  const label = providerLabel(consent.provider as Parameters<typeof providerLabel>[0], ai ?? undefined);
  // `compatible` covers many servers: this one, by name
  const origin = consent.provider === "compatible" && consent.endpoint && URL.canParse(consent.endpoint) ? new URL(consent.endpoint).host : null;
  return (
    <section className="space-y-2" data-testid="ask-consent">
      <p className="text-sm">{t("ask.consent", { provider: origin ? `${label} (${origin})` : label })}</p>
      <div className="flex gap-2">
        <Button size="sm" data-testid="ask-consent-continue" onKeyDown={stopKeys} onClick={() => askQuestion(consent.question, { acknowledge: consent.destination })}>{t("common.continue")}</Button>
        <Button size="sm" variant="secondary" data-testid="ask-consent-settings" onKeyDown={stopKeys} onClick={() => { declineConsent(); setApp({ dialog: "settings", settingsTab: "ai" }); }}>{t("common.settings")}</Button>
      </div>
    </section>
  );
}

function Failure() {
  const error = useAsk((s) => s.error);
  const ai = useApp((s) => s.settings?.ai);
  if (!error) return null;
  const help = ai ? errorHelp(error.kind, ai) : null;
  return (
    <section className="space-y-1.5" data-testid="ask-error">
      <p className="text-sm text-destructive-ink">{error.message}</p>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      <Button size="sm" variant="secondary" data-testid="ask-retry" onKeyDown={stopKeys} onClick={() => askQuestion(error.question)}>{t("ask.tryAgain")}</Button>
    </section>
  );
}

function SourceRow({ source, n }: { source: AskSourceRef; n: number }) {
  const view = useAsk((s) => s.sources[source.messageId]?.state ?? "ok");
  const armed = useAsk((s) => s.armedSource === source.messageId);
  const gone = view === "gone";
  const moved = view === "spam" || view === "trash";
  return (
    <CommandItem value={`source\u0000${source.messageId}\u0000${n}`} disabled={gone} data-testid="ask-source" data-state-view={view} onSelect={() => void openSource(source)}>
      <span className="w-5 shrink-0 text-xs text-muted-foreground tabular">[{n}]</span>
      <span className="w-32 shrink-0 truncate">{source.fromName || source.fromEmail}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{gone ? t("ask.source.gone") : moved ? t(armed ? "ask.source.pressAgain" : view === "spam" ? "ask.source.spam" : "ask.source.trash") : source.subject}</span>
      <CommandDescription>{listDate(source.date)}</CommandDescription>
    </CommandItem>
  );
}

/** The page's own keys: Esc stops first, the follow-up box types, arrows still walk the rows. */
function FollowUp({ disabled }: { disabled: boolean }) {
  const [value, setValue] = useState("");
  const running = useAsk((s) => s.running !== null);
  const ref = useRef<HTMLInputElement>(null);
  const armed = useRef(false);
  useLayoutEffect(() => ref.current?.focus(), []);
  return (
    <div className="border-t border-border/60 px-[18px] py-2">
      <input
        ref={ref}
        data-testid="ask-follow-up"
        data-ask-followup
        aria-label={t("ask.followUp")}
        placeholder={disabled ? t("ask.tooLong") : t("ask.followUp")}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          armed.current = false;
          setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            armed.current = true;
            return;
          }
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          // a row walked to with the arrows opens; otherwise Enter here is this box's
          if (!value.trim() && armed.current) return;
          e.stopPropagation();
          e.preventDefault();
          if (!value.trim() || running) return;
          askQuestion(value);
          setValue("");
        }}
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
    </div>
  );
}

function Conversation({ onBack }: { onBack: () => void }) {
  const turns = useAsk((s) => s.turns);
  const running = useAsk((s) => s.running);
  const incomplete = useAsk((s) => s.incomplete);
  const atLimit = useAsk(atTurnLimit);
  const enabled = useApp((s) => s.settings?.ask?.enabled !== false);
  const title = turns[0]?.question ?? running?.question ?? "";
  const last = turns.at(-1);
  const area = useRef<HTMLDivElement>(null);
  const size = (running?.text.length ?? 0) + turns.length;
  useLayoutEffect(() => {
    const el = area.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [size]);
  return (
    <>
      <div className="flex h-11 items-center gap-2 border-b border-border/60 px-3 text-sm" data-testid="ask-header">
        <Sparkles className="size-[1.15em] shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" data-testid="ask-title">{title}</span>
        <Chip data-testid="palette-page" onRemove={onBack} removeLabel={t("palette.back")} removeProps={{ "data-testid": "palette-back", onKeyDown: stopKeys }}>{t("palette.ask.page")}</Chip>
      </div>
      {/* tabbable: it scrolls, and a keyboard has to reach what it holds */}
      <div ref={area} tabIndex={0} data-testid="ask-area" className="max-h-72 space-y-4 overflow-y-auto px-[18px] py-3 outline-none">
        {turns.map((turn, i) => (
          turn.kind === "command" ? <CommandTurn key={turn.id} turn={turn} last={turn === last} /> : <Turn key={turn.id} turn={turn} last={turn === last} repeated={turn.question === (i === 0 ? title : turns[i - 1]!.question)} />
        ))}
        <Running />
        <Consent />
        <Failure />
        <CommandNotice />
        <Older />
        {incomplete && <p className="text-xs text-muted-foreground" data-testid="ask-incomplete">{t("ask.incomplete")}</p>}
        <OlderLimit />
      </div>
      <CommandList label={t("ask.sources")} className="max-h-44 border-t border-border/60 p-1.5">
        {last && last.sources.length > 0 && (
          <CommandGroup heading={t("ask.sources")} data-group="ask-sources">
            {last.sources.map((source, i) => (
              <SourceRow key={source.messageId} source={source} n={i + 1} />
            ))}
          </CommandGroup>
        )}
        <CommandGroup value="ask-actions" forceMount>
          <CommandItem forceMount value="ask-new" data-testid="ask-new" onSelect={() => newQuestion()}>
            <Plus /> {t("ask.new")}
          </CommandItem>
          <CommandItem forceMount value="ask-history" data-testid="ask-history-row" onSelect={() => setPalettePage("askHistory")}>
            <Clock /> {t("palette.askHistory")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <FollowUp disabled={atLimit || !enabled} />
    </>
  );
}

/** No question yet: the palette's own input, and Enter on a row. */
function Empty({ value, setValue, onBack }: { value: string; setValue: (v: string) => void; onBack: () => void }) {
  const running = useAsk((s) => s.running);
  const consent = useAsk((s) => s.consent);
  const error = useAsk((s) => s.error);
  const query = value.trim();
  const busy = running !== null || consent !== null || error !== null;
  return (
    <>
      <CommandInput
        autoFocus
        placeholder={t("ask.placeholder")}
        value={value}
        onValueChange={setValue}
        data-testid="palette-input"
        addon={<Chip data-testid="palette-page" onRemove={onBack} removeLabel={t("palette.back")} removeProps={{ "data-testid": "palette-back", onKeyDown: stopKeys }}>{t("palette.ask.page")}</Chip>}
      />
      {busy && (
        <div className="space-y-3 px-[18px] py-3" data-testid="ask-area">
          <Running />
          <Consent />
          <Failure />
        </div>
      )}
      {!busy && (
        <CommandList label={t("palette.results")}>
          <div className="px-[18px] py-2 empty:hidden"><CommandNotice /></div>
          {query && (
            <CommandGroup value="ask-go" forceMount>
              <CommandItem forceMount value={`ask\u0000${value}`} data-testid="ask-submit" onSelect={() => { askQuestion(value); setValue(""); }}>
                <Search /> {t("palette.askRow", { query: value })}
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup value="ask-actions" forceMount>
            <CommandItem forceMount value="ask-history" data-testid="ask-history-row" onSelect={() => setPalettePage("askHistory")}>
              <Clock /> {t("palette.askHistory")}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      )}
    </>
  );
}

function NoProvider() {
  return (
    <div className="space-y-3 px-[18px] py-5" data-testid="ask-no-provider">
      <p className="text-sm">{t("ask.noProvider")}</p>
      <Button size="sm" data-testid="ask-open-settings" onKeyDown={stopKeys} onClick={() => setApp({ dialog: "settings", settingsTab: "ai" })}>{t("ask.noProvider.open")}</Button>
    </div>
  );
}

function AskQuestionPage({ value, setValue, onBack }: { value: string; setValue: (v: string) => void; onBack: () => void }) {
  const ready = useApp((s) => askReady(s.settings?.ai));
  const noProvider = useAsk((s) => s.noProvider);
  // a key added, a provider chosen: what said it had nowhere to go asks again
  const aiSettings = useApp((s) => s.settings?.ai);
  useEffect(() => askConfigChanged(), [aiSettings]);
  const hasConversation = useAsk((s) => s.conversationId !== null || s.turns.length > 0);
  const running = useAsk((s) => s.running);
  const announced = useAsk((s) => s.ready);
  const announcedAtOpen = useRef(announced);
  // what the palette's last row asked, and where ⌘⇧K returns
  useEffect(() => {
    const asked = askFrom.question;
    askFrom.question = null;
    // the root's row is a question of its own, not a follow-up on the last conversation
    if (asked) {
      newQuestion();
      askQuestion(asked);
    } else returning();
  }, []);
  useEffect(() => {
    paletteKeys.escape = () => stopAsking();
    return () => {
      paletteKeys.escape = null;
    };
  }, []);
  const content: ReactNode = !ready || noProvider ? <NoProvider /> : hasConversation || running ? <Conversation onBack={onBack} /> : <Empty value={value} setValue={setValue} onBack={onBack} />;
  return (
    <>
      {content}
      {/* never the deltas: what's underway, and that it's done */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="ask-live">
        {running ? t("ask.lookingShort") : announced !== announcedAtOpen.current ? t("ask.ready") : ""}
      </div>
    </>
  );
}

function when(ms: number): string {
  return listDate(ms);
}

/** Previous AI questions: filtered as you type, in memory over the 100 rows. */
function AskHistoryPage({ value, setValue, onBack }: { value: string; setValue: (v: string) => void; onBack: () => void }) {
  const [list, setList] = useState<AskConversationSummary[] | null>(null);
  const [deleted, setDeleted] = useState<AskConversationSummary | null>(null);
  /** the delete of this page: its own event doesn't take away its Undo */
  const deletedHere = useRef<number | null>(null);
  const refresh = () => void loadAskHistory().then(setList, () => setList([]));
  // anything going, here or in another window: the list as it is now, and no Undo for what can't come back
  const gone = useAsk((s) => s.gone);
  useEffect(() => {
    refresh();
    const own = deletedHere.current;
    deletedHere.current = null;
    if (gone) setDeleted((d) => (d && own === d.id ? d : null));
  }, [gone]);
  const query = value.trim().toLowerCase();
  const shown = useMemo(() => (list ?? []).filter((c) => !query || c.title.toLowerCase().includes(query)), [list, query]);
  const open = async (id: number) => {
    if (await openConversation(id)) setPalettePage("ask");
    else refresh();
  };
  return (
    <div
      onKeyDownCapture={(e) => {
        if (!((e.metaKey || e.ctrlKey) && e.key === "Backspace")) return;
        const row = e.currentTarget.querySelector<HTMLElement>('[data-slot="command-item"][data-selected="true"]');
        const id = Number(row?.dataset.conversation);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        deletedHere.current = id;
        setDeleted(list?.find((c) => c.id === id) ?? null);
        void deleteConversation(id).then(refresh);
      }}
    >
      <CommandInput
        autoFocus
        placeholder={t("palette.askHistoryPlaceholder")}
        value={value}
        onValueChange={setValue}
        data-testid="palette-input"
        addon={<Chip data-testid="palette-page" onRemove={onBack} removeLabel={t("palette.back")} removeProps={{ "data-testid": "palette-back", onKeyDown: stopKeys }}>{t("palette.askHistory")}</Chip>}
      />
      <CommandList label={t("palette.askHistory")}>
        {list !== null && !deleted && <CommandEmpty>{query ? t("palette.empty") : t("palette.askHistoryEmpty")}</CommandEmpty>}
        {deleted && (
          <CommandGroup value="ask-undo" forceMount>
            <CommandItem forceMount value="ask-undo" data-testid="ask-history-undo" onSelect={() => { const id = deleted.id; setDeleted(null); void restoreConversation(id).then(refresh); }}>
              <Undo2 /> <span className="truncate">{t("ask.deleted", { title: deleted.title })}</span>
              <CommandDescription>{t("common.undo")}</CommandDescription>
            </CommandItem>
          </CommandGroup>
        )}
        {shown.map((c) => (
          <CommandItem key={c.id} value={`c${c.id}`} data-conversation={c.id} data-testid="ask-history-item" onSelect={() => void open(c.id)}>
            <Mail /> <span className="truncate">{c.title}</span>
            {c.followUps > 0 && <span className="shrink-0 text-xs text-muted-foreground" data-testid="ask-history-followups">{t("ask.history.followUps", { count: c.followUps })}</span>}
            <CommandDescription>{when(c.updatedAt)}</CommandDescription>
            <CommandShortcut className="ms-3 hidden in-data-[selected=true]:inline">{chordLabel("mod+backspace")}</CommandShortcut>
          </CommandItem>
        ))}
      </CommandList>
    </div>
  );
}

export default function AskPages({ page, value, setValue, onBack }: { page: "ask" | "askHistory"; value: string; setValue: (v: string) => void; onBack: () => void }) {
  return page === "ask" ? <AskQuestionPage value={value} setValue={setValue} onBack={onBack} /> : <AskHistoryPage value={value} setValue={setValue} onBack={onBack} />;
}


