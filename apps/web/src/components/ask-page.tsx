import { answerWithoutCitations, type AskConversationSummary, type AskPlanQuery, type AskSourceRef, type AskTurn } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CloseButton } from "@terno/ui/components/close-button";
import { CommandDescription, CommandEmpty, CommandGroup, CommandHints, CommandInput, CommandItem, CommandList, CommandShortcut } from "@terno/ui/components/command";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { ChevronLeft, Clock, ExternalLink, Mail, Plus, RefreshCw, Search, Sparkles, Undo2 } from "@terno/ui/icons";
import { useCommandState } from "cmdk";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { askReady, errorHelp } from "~/lib/ai";
import { closePeek, showSource, usePeek, type Peek } from "~/lib/ask-peek";
import { Marked } from "~/components/match-mark";
import { citationRuns } from "~/lib/ask-citations";
import { cn } from "@terno/ui/lib/utils";
import { askConfigChanged, askQuestion, atTurnLimit, deleteConversation, loadAskHistory, newQuestion, openConversation, openSource, restoreConversation, returning, searchOlder, stopAsking, useAsk } from "~/lib/ask";
import { listDate } from "~/lib/format";
import { askFrom, paletteKeys, setPalettePage } from "~/lib/palette-open";
import { chordLabel } from "@terno/ui/components/shortcut";
import { useApp, setApp } from "~/state/app";
import { AiCopyButton, AiProvenance } from "~/components/ai-provenance";


const stopKeys = (e: KeyboardEvent) => {
  // a control's own Enter and Space stay out of the list's: cmdk selects the active row whichever control has focus (revision 12)
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
};

/** the source row cmdk has chosen (↑↓ in the follow-up box walk them): its message, so its citation lights with it */
function useChosenSource(): number | null {
  const value = useCommandState((state) => state.value);
  const [kind, id] = (value ?? "").split("\u0000");
  return kind === "source" && id ? Number(id) : null;
}

/** a source said in a line: who and when, for a citation's tooltip */
const sourceLine = (source: AskSourceRef) => t("ask.source.from", { from: source.fromName || source.fromEmail, date: listDate(source.date) });

/**
 * "…renews on 1 March.¹": a citation is a small numbered marker, a button to that source, bound to the word before it
 * and the punctuation after it (plan 161: no line starts with "."). Plan 161, pass 3: the button's own box is 24 × 24
 * (a rater's ruler measures the element), the number pill drawn inside; its block margins take back what the line would
 * grow by, and its inline ones what would push the pill off its word and the "." after it (an `after:` layer over the
 * same box takes the pointer where it reaches past the line, which Chromium doesn't hit-test). Its number is full ink on
 * the field's wash; hover or focus names the source, the source row chosen with ↑↓ lights its number here, and a click
 * shows the message in Ask (`ask-peek.ts`).
 */
function AnswerText({ text, sources, queries, chosen = null }: { text: string; sources: readonly AskSourceRef[]; queries: readonly AskPlanQuery[]; chosen?: number | null }) {
  const views = useAsk((s) => s.sources);
  const marker = (n: number, key: number) => {
    const source = sources[n - 1];
    if (!source || views[source.messageId]?.state === "gone") return <span key={key}>[{n}]</span>;
    const lit = chosen === source.messageId;
    return (
      <Tooltip key={key}>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-testid="ask-citation"
              data-lit={lit || undefined}
              onKeyDown={stopKeys}
              onClick={() => void showSource(source, n, queries)}
              className="group/cite relative z-[1] -my-1 -ms-0.5 -me-1 inline-flex size-6 items-center justify-center rounded-md align-[0.05em] outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("ask.citation", { n, subject: source.subject })}
            />
          }
        >
          <span aria-hidden className={cn("inline-grid h-[1.4em] min-w-[1.4em] place-items-center rounded-[0.4em] px-[0.3em] text-2xs leading-none font-semibold text-foreground tabular transition-colors duration-fast", lit ? "bg-primary/15" : "bg-field group-hover/cite:bg-muted")}>{n}</span>
        </TooltipTrigger>
        <TooltipContent data-testid="ask-citation-preview">
          <span className="block font-medium">{source.subject || t("common.noSubject")}</span>
          <span className="block">{sourceLine(source)}</span>
        </TooltipContent>
      </Tooltip>
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
  const chosen = useChosenSource();
  if (!turn.answer && !last) return null;
  return (
    <section className="space-y-1.5" data-testid="ask-turn" data-status={turn.status}>
      {/* the header already says it, as does the turn before it when older mail answered again */}
      {/* plan 161, pass 2: a follow-up reads as a question, as the header's does, not as a caption */}
      <h3 className={repeated ? "sr-only" : "text-sm font-medium"} data-testid="ask-question">{turn.question}</h3>
      {turn.answer ? <AnswerText text={turn.answer} sources={turn.sources} queries={turn.queries} chosen={last ? chosen : null} /> : null}
      <Armed sources={turn.sources} />
      {turn.status === "stopped" && <p className="text-xs text-muted-foreground" data-testid="ask-stopped">{t("ask.stopped")}</p>}
      <Checks turn={turn} />
      {turn.answer && (
        // plan 161, pass 2: buttons that look like buttons, their edge on the answer's
        <div className="flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground" data-testid="ask-turn-actions">
          {/* plan 161, pass 3: the one Copy and the one "Written with AI ▾" every AI surface has */}
          <AiCopyButton text={() => answerWithoutCitations(turn.answer ?? "")} failed={t("ask.copyFailed")} testId="ask-copy" onKeyDown={stopKeys} />
          {last && !running && (
            // it asks the same question once more; the new answer comes under this one
            <Button variant="outline" size="xs" data-testid="ask-again" onKeyDown={stopKeys} onClick={() => askQuestion(turn.question)}><RefreshCw /> {t("ask.again")}</Button>
          )}
          <AiProvenance model={turn.model ?? ""} at={turn.createdAt} testId="ask-provenance" className="ml-auto" onKeyDown={stopKeys} />
        </div>
      )}
      {last && turn.answer && <Scope />}
      {/* plan 161, pass 2: what an earlier turn cited stays under it (the last turn's are the palette's rows) */}
      {!last && turn.sources.length > 0 && <TurnSources sources={turn.sources} queries={turn.queries} />}
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
      <OlderButton />
    </div>
  );
}

/**
 * Plan 161: under an answer, how far back it looked, and the way past that, on one line: what Search older mail adds is
 * said by what it's next to.
 */
export function Scope() {
  const offer = useAsk((s) => s.older);
  const last = useAsk((s) => s.turns.at(-1));
  const found = useAsk((s) => s.olderFound);
  const running = useAsk((s) => s.running !== null);
  const enabled = useApp((s) => s.settings?.ask?.enabled !== false);
  if (!enabled || running || !last || last.status === "not_found" || last.status === "partial" || found === 0) return null;
  // still downloading: what it looked through isn't settled yet, and older mail waits for it
  if (offer.kind === "downloading") return <p className="text-xs text-muted-foreground" data-testid="ask-older-downloading">{t("ask.older.downloading")}</p>;
  const since = "since" in offer && offer.since ? offer.since : null;
  if (offer.kind === "none" || !since) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="ask-scope">
      <span>{t("ask.scope", { date: listDate(since) })}</span>
      {/* plan 161, pass 3: after an answer, the way past it is a quiet link in the scope's line, below the answer and its sources in weight */}
      {offer.kind === "offline" ? <span data-testid="ask-older-offline">{t("ask.older.offline")}</span> : (
        <Button variant="link-secondary" size="xs" className="h-6 font-medium" data-testid="ask-older" onKeyDown={stopKeys} onClick={searchOlder}>{t("ask.older.servers")}</Button>
      )}
    </p>
  );
}

/** Plan 161, pass 2: older mail when nothing here answers, the main action there (pass 3: an answer's scope line has it as a link). */
function OlderButton() {
  return (
    <Button variant="outline" size="xs" data-testid="ask-older" onKeyDown={stopKeys} onClick={searchOlder}>
      <Search /> {t("ask.older.servers")}
    </Button>
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

/** A source's number, sender, subject (or where it went) and date: a palette row's, and an earlier turn's alike. */
function SourceCells({ source, n }: { source: AskSourceRef; n: number }) {
  const view = useAsk((s) => s.sources[source.messageId]?.state ?? "ok");
  const armed = useAsk((s) => s.armedSource === source.messageId);
  const moved = view === "spam" || view === "trash";
  return (
    <>
      {/* the inline marker's look, so a citation and its row read as one number */}
      <span className="w-5 shrink-0"><span data-testid="ask-source-n" className="inline-grid h-[1.4em] min-w-[1.4em] place-items-center rounded-[0.4em] bg-field px-[0.3em] text-2xs leading-none font-semibold text-foreground tabular">{n}</span></span>
      <span className="w-32 shrink-0 truncate">{source.fromName || source.fromEmail}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{view === "gone" ? t("ask.source.gone") : moved ? t(armed ? "ask.source.pressAgain" : view === "spam" ? "ask.source.spam" : "ask.source.trash") : source.subject}</span>
      <CommandDescription>{listDate(source.date)}</CommandDescription>
    </>
  );
}

function SourceRow({ source, n, queries }: { source: AskSourceRef; n: number; queries: readonly AskPlanQuery[] }) {
  const view = useAsk((s) => s.sources[source.messageId]?.state ?? "ok");
  return (
    <CommandItem value={`source\u0000${source.messageId}\u0000${n}`} disabled={view === "gone"} data-testid="ask-source" data-state-view={view} onSelect={() => void showSource(source, n, queries)}>
      <SourceCells source={source} n={n} />
    </CommandItem>
  );
}

/** An earlier turn's sources, under its answer: the rows' anatomy, as buttons (Tab reaches them; ↑↓ are the last turn's). */
function TurnSources({ sources, queries }: { sources: readonly AskSourceRef[]; queries: readonly AskPlanQuery[] }) {
  const views = useAsk((s) => s.sources);
  return (
    <div className="pt-1" data-testid="ask-turn-sources">
      <h4 className="text-xs font-medium text-muted-foreground">{t("ask.sources")}</h4>
      {/* -mx-3: the rows' words on the answer's edge, their shapes reaching past it, as the palette's rows do */}
      <ul className="-mx-3 mt-0.5 flex flex-col gap-0.5">
        {sources.map((source, i) => (
          <li key={source.messageId}>
            <button type="button" data-testid="ask-turn-source" disabled={views[source.messageId]?.state === "gone"} onKeyDown={stopKeys} onClick={() => void showSource(source, i + 1, queries)} className="flex h-8 w-full items-center gap-2 rounded-(--command-radius) px-3 text-start text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground">
              <SourceCells source={source} n={i + 1} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Plan 161, pass 3: the way back to all commands, as words that say so, and a plain close. In place of the page chip,
 * whose × read as close.
 */
function AskNav({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" data-testid="ask-nav">
      <Button variant="ghost" size="xs" className="font-medium text-muted-foreground" data-testid="palette-back" onKeyDown={stopKeys} onClick={onBack}>
        <ChevronLeft /> {t("ask.allCommands")}
      </Button>
      <CloseButton size="sm" data-testid="ask-close" onKeyDown={stopKeys} onClick={onClose} />
    </span>
  );
}

/** Plan 161, pass 3: what the keys do where you are, never a promise they don't keep. */
type Where = "empty" | "asking" | "walking" | "peek";
function AskHints({ where, sources, end }: { where: Where; sources: boolean; end?: ReactNode }) {
  const running = useAsk((s) => s.running !== null);
  const esc = { keys: ["escape"], label: running ? t("ask.stop") : t("ask.allCommands") };
  const hints =
    where === "peek"
      ? [{ keys: ["enter"], label: t("ask.peek.open") }, { keys: ["escape"], label: t("ask.peek.back") }]
      : where === "walking"
        ? [{ keys: ["arrowup", "arrowdown"], label: t("ask.keys.sources") }, { keys: ["enter"], label: t("ask.keys.show") }, esc]
        : [{ keys: ["enter"], label: t("ask.keys.ask") }, ...(sources && where === "asking" ? [{ keys: ["arrowdown"], label: t("ask.keys.sources") }] : []), esc];
  return <CommandHints hints={hints} end={end} data-testid="ask-hints" data-where={where} />;
}

/** The page's own keys: Esc stops first, the follow-up box types, arrows walk the sources (and say so below). */
function FollowUp({ disabled, onWalk, inputRef: ref }: { disabled: boolean; onWalk: (walking: boolean) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const [value, setValue] = useState("");
  const running = useAsk((s) => s.running !== null);
  const armed = useRef(false);
  useLayoutEffect(() => ref.current?.focus(), []);
  const walk = (on: boolean) => {
    armed.current = on;
    onWalk(on);
  };
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
          walk(false);
          setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            walk(true);
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

/** At most this much of a message is drawn in Ask: enough to check a claim; Open message has the rest. */
const PEEK_CHARS = 20_000;

/**
 * Plan 161, pass 3: a cited message, in Ask, in place of the answer: the way back, the source as its row says it, the
 * passage the searches found, and the message's text. Enter opens it in the reader; Esc comes back (`paletteKeys`).
 */
function PeekView({ peek }: { peek: Peek }) {
  const body = useRef<HTMLDivElement>(null);
  // programmatic: no ring (plan 54), and the keys are the preview's (↑↓ scroll it, Enter opens it)
  useLayoutEffect(() => body.current?.focus({ preventScroll: true }), [peek.source.messageId]);
  const { source } = peek;
  const armed = useAsk((s) => s.armedSource === source.messageId);
  const view = useAsk((s) => s.sources[source.messageId]?.state);
  // still this preview, in this conversation: a late answer opens nothing (Codex review, pass 3, round 2)
  const conversation = useAsk((s) => s.conversationId);
  const open = () => void openSource(source, peek.approved, () => usePeek.getState().peek?.source.messageId === source.messageId && useAsk.getState().conversationId === conversation);
  const text = peek.text.length > PEEK_CHARS ? `${peek.text.slice(0, PEEK_CHARS)}…` : peek.text;
  return (
    <section
      data-testid="ask-peek"
      data-state={peek.state}
      aria-label={t("ask.peek.region", { n: peek.n, subject: source.subject || t("common.noSubject") })}
      onKeyDown={(e) => {
        // the rows under it keep their chosen one: cmdk's keys (↑↓, Home, End, Enter, and Ctrl+N/P/J/K) never reach them
        // from here (Codex review, pass 3, round 2). Esc is the palette's, in its capture phase.
        if (["ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown", "Enter"].includes(e.key) || (e.ctrlKey && ["n", "p", "j", "k"].includes(e.key.toLowerCase()))) e.stopPropagation();
      }}
    >
      <div className="flex items-center gap-2 px-[18px] pt-2.5">
        {/* -ms-2: its words on the column's edge, its shape reaching past it */}
        <Button variant="ghost" size="xs" className="-ms-2 font-medium" data-testid="ask-peek-back" onKeyDown={stopKeys} onClick={() => closePeek()}>
          <ChevronLeft /> {t("ask.peek.back")}
        </Button>
        <Button variant="outline" size="xs" className="ms-auto" data-testid="ask-peek-open" onKeyDown={stopKeys} onClick={open}>
          <ExternalLink /> {t("ask.peek.open")}
        </Button>
      </div>
      <div
        ref={body}
        tabIndex={0}
        data-testid="ask-peek-body"
        className="max-h-80 space-y-3 overflow-y-auto px-[18px] pt-2 pb-3 outline-none"
        onKeyDown={(e) => {
          // Enter here opens it (the section keeps every navigation key from cmdk)
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            open();
          }
        }}
      >
        <div className="flex items-center gap-2 text-sm">
          <span aria-hidden className="inline-grid h-[1.4em] min-w-[1.4em] place-items-center rounded-[0.4em] bg-field px-[0.3em] text-2xs leading-none font-semibold text-foreground tabular">{peek.n}</span>
          <span className="min-w-0 truncate font-medium" data-testid="ask-peek-from">{source.fromName || source.fromEmail}</span>
          <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular">{listDate(source.date)}</span>
        </div>
        <h3 className="text-sm font-medium text-pretty" data-testid="ask-peek-subject">{source.subject || t("common.noSubject")}</h3>
        {/* moved to Spam or Trash since it was shown: Open message asks once more, said here (round 2) */}
        <p role="status" className="text-xs text-muted-foreground empty:hidden" data-testid="ask-peek-armed">
          {armed && (view === "spam" || view === "trash") ? `${t(view === "spam" ? "ask.source.spam" : "ask.source.trash")}. ${t("ask.source.pressAgain")}` : null}
        </p>
        {peek.state === "loading" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-peek-loading"><Spinner className="size-3.5" /> {t("ask.peek.loading")}</p>
        )}
        {peek.state === "failed" && <p className="text-sm text-muted-foreground" data-testid="ask-peek-failed">{t("ask.peek.failed")}</p>}
        {peek.state === "ready" && peek.passage && (
          <figure className="space-y-1" data-testid="ask-peek-passage">
            <figcaption className="text-xs font-medium text-muted-foreground">{t("ask.peek.passage")}</figcaption>
            <blockquote className="border-s-2 border-border ps-3 text-sm leading-relaxed">
              <Marked text={peek.passage} needles={peek.needles} testId="ask-peek-mark" />
            </blockquote>
          </figure>
        )}
        {peek.state === "ready" && <p className="text-sm leading-relaxed break-words whitespace-pre-wrap" data-testid="ask-peek-text">{text}</p>}
      </div>
    </section>
  );
}

function Conversation({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const turns = useAsk((s) => s.turns);
  const running = useAsk((s) => s.running);
  const incomplete = useAsk((s) => s.incomplete);
  const atLimit = useAsk(atTurnLimit);
  const enabled = useApp((s) => s.settings?.ask?.enabled !== false);
  const peek = usePeek((s) => s.peek);
  const chosen = useChosenSource();
  const [walking, setWalking] = useState(false);
  const title = turns[0]?.question ?? running?.question ?? "";
  const last = turns.at(-1);
  const area = useRef<HTMLDivElement>(null);
  const followUp = useRef<HTMLInputElement>(null);
  const size = (running?.text.length ?? 0) + turns.length;
  useLayoutEffect(() => {
    const el = area.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [size]);
  // back from a shown source: the keys are the follow-up box's again (its words, the place read to and the row chosen
  // were kept: the conversation stays mounted under the source, Codex review (pass 3) #1, #5, #6)
  const peeked = useRef(false);
  useLayoutEffect(() => {
    if (peek) peeked.current = true;
    else if (peeked.current) {
      peeked.current = false;
      followUp.current?.focus({ preventScroll: true });
    }
  }, [peek]);
  const sources = (last?.sources.length ?? 0) > 0;
  // plan 161, pass 3: starting over and the history are quiet controls at the end of the keys' line, not rows of their own
  const session = !peek && (
    <>
      <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" data-testid="ask-new" onKeyDown={stopKeys} onClick={() => newQuestion()}>
        <Plus /> {t("ask.new")}
      </Button>
      <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" data-testid="ask-history-row" onKeyDown={stopKeys} onClick={() => setPalettePage("askHistory")}>
        <Clock /> {t("palette.askHistory")}
      </Button>
    </>
  );
  return (
    <>
      <div className="flex h-11 items-center gap-2 border-b border-border/60 ps-3 pe-2.5 text-sm" data-testid="ask-header">
        <Sparkles className="size-[1.15em] shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" data-testid="ask-title">{title}</span>
        <AskNav onBack={onBack} onClose={onClose} />
      </div>
      {peek && <PeekView peek={peek} />}
      {/* under a shown source, out of sight, reach and the accessibility tree, but kept: not unmounted */}
      <div inert={peek !== null} className={cn(peek && "invisible h-0 overflow-hidden")} data-testid="ask-conversation">
          {/* tabbable: it scrolls, and a keyboard has to reach what it holds */}
          <div ref={area} tabIndex={0} data-testid="ask-area" className="max-h-72 space-y-4 overflow-y-auto px-[18px] py-3 outline-none">
            {turns.map((turn, i) => (
              turn.kind === "command" ? <CommandTurn key={turn.id} turn={turn} last={turn === last} /> : <Turn key={turn.id} turn={turn} last={turn === last} repeated={turn.question === (i === 0 ? title : turns[i - 1]!.question)} />
            ))}
            <Running />
            <Failure />
            <CommandNotice />
            <Older />
            {incomplete && <p className="text-xs text-muted-foreground" data-testid="ask-incomplete">{t("ask.incomplete")}</p>}
            <OlderLimit />
          </div>
          {last && sources && (
            <CommandList label={t("ask.sources")} className="max-h-44 border-t border-border/60 p-1.5">
              <CommandGroup heading={t("ask.sources")} data-group="ask-sources">
                {last.sources.map((source, i) => (
                  <SourceRow key={source.messageId} source={source} n={i + 1} queries={last.queries} />
                ))}
              </CommandGroup>
            </CommandList>
          )}
          <FollowUp disabled={atLimit || !enabled} onWalk={setWalking} inputRef={followUp} />
      </div>
      <AskHints where={peek ? "peek" : walking && chosen !== null ? "walking" : "asking"} sources={sources} end={session} />
    </>
  );
}

/** No question yet: the palette's own input, and Enter on a row. */
function Empty({ value, setValue, onBack, onClose }: { value: string; setValue: (v: string) => void; onBack: () => void; onClose: () => void }) {
  const running = useAsk((s) => s.running);
  const error = useAsk((s) => s.error);
  const query = value.trim();
  const busy = running !== null || error !== null;
  return (
    <>
      <CommandInput
        autoFocus
        placeholder={t("ask.placeholder")}
        value={value}
        onValueChange={setValue}
        data-testid="palette-input"
        end={<AskNav onBack={onBack} onClose={onClose} />}
      />
      {busy && (
        <div className="space-y-3 px-[18px] py-3" data-testid="ask-area">
          <Running />
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
      <AskHints where="empty" sources={false} />
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

function AskQuestionPage({ value, setValue, onBack, onClose }: { value: string; setValue: (v: string) => void; onBack: () => void; onClose: () => void }) {
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
    // plan 161, pass 3: Esc leaves a shown source first, back to its answer; then a running answer stops; then back
    paletteKeys.escape = () => closePeek() || stopAsking();
    return () => {
      paletteKeys.escape = null;
      closePeek();
    };
  }, []);
  const content: ReactNode = !ready || noProvider ? <NoProvider /> : hasConversation || running ? <Conversation onBack={onBack} onClose={onClose} /> : <Empty value={value} setValue={setValue} onBack={onBack} onClose={onClose} />;
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
function AskHistoryPage({ value, setValue, onBack, onClose }: { value: string; setValue: (v: string) => void; onBack: () => void; onClose: () => void }) {
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
        end={<AskNav onBack={onBack} onClose={onClose} />}
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

export default function AskPages({ page, value, setValue, onBack, onClose }: { page: "ask" | "askHistory"; value: string; setValue: (v: string) => void; onBack: () => void; onClose: () => void }) {
  return page === "ask" ? <AskQuestionPage value={value} setValue={setValue} onBack={onBack} onClose={onClose} /> : <AskHistoryPage value={value} setValue={setValue} onBack={onBack} onClose={onClose} />;
}


