import { answerSentences, answerWithoutCitations, cleanAnswer, sameNamePeople, type AiErrorKind, type AskConversationSummary, type AskPlanQuery, type AskSourceRef, type AskSourceView, type AskTurn } from "@terno/core";
import type { AiSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { CloseButton } from "@terno/ui/components/close-button";
import { CommandDescription, CommandEmpty, CommandGroup, CommandHints, CommandInput, CommandItem, CommandList, CommandShortcut } from "@terno/ui/components/command";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Check, ChevronLeft, Clock, ExternalLink, Mail, Pin, Plus, RefreshCw, Search, Sparkles, Undo2 } from "@terno/ui/icons";
import { useCommandState } from "cmdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { askReady, askTarget } from "~/lib/ai";
import { closePeek, showSource, usePeek, type Peek } from "~/lib/ask-peek";
import { Marked } from "~/components/match-mark";
import { answerBlocks, boldParts, citationRuns } from "~/lib/ask-citations";
import { cn } from "@terno/ui/lib/utils";
import { askConfigChanged, askPlace, askQuestion, atTurnLimit, deleteConversation, loadAskHistory, newQuestion, openConversation, openSource, keepAskPlace, restoreConversation, returning, searchOlder, stopAsking, useAsk, useVisited } from "~/lib/ask";
import { pinAnswer, unpinAnswer } from "~/lib/pinned-ask";
import { usePinnedAsk } from "~/lib/pinned-ask-state";
import { listDate } from "~/lib/format";
import { getLocale } from "@terno/i18n";
import { boundaryDay } from "~/lib/when";
import { askFrom, paletteBack, paletteKeys, setPalettePage, usePalettePage } from "~/lib/palette-open";
import { chordLabel } from "@terno/ui/components/shortcut";
import { useApp, setApp } from "~/state/app";
import { AiCopyButton, AiProvenance } from "~/components/ai-provenance";
import { AiErrorNotice, aiErrorCopy, errorTarget, type AiErrorCopy } from "~/components/ai-error";


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
export function AnswerText({ text, sources, queries, chosen = null, unlinked = false, conversationId, open, views: own }: {
  text: string;
  sources: readonly AskSourceRef[];
  queries: readonly AskPlanQuery[];
  chosen?: number | null;
  /** unlinked claims are marked (never in a stopped answer) */
  unlinked?: boolean;
  /** plan 165: whose sources these are, for what's been read */
  conversationId: number | null;
  /** plan 165: what a citation does (the pinned answer opens the reader); else it shows the message in Ask */
  open?: (source: AskSourceRef, n: number) => void;
  /** the pinned answer's own copy of where its sources were, under what Ask knows now */
  views?: Readonly<Record<number, AskSourceView>>;
}) {
  const live = useAsk((s) => s.sources);
  const views = own ? { ...own, ...live } : live;
  // plan 162 (after ai162-r05, Codex review): a citation's preview stays inside Ask's dialog, at either edge (plan 165:
  // or the pinned answer's card)
  const [panel, setPanel] = useState<Element | null>(null);
  const answerRef = useCallback((el: HTMLElement | null) => setPanel(el?.closest("[role=dialog], [data-testid=pinned-ask]") ?? null), []);
  const marker = (n: number, key: number) => {
    const source = sources[n - 1];
    if (!source || views[source.messageId]?.state === "gone") return <span key={key}>[{n}]</span>;
    return <Citation key={key} source={source} n={n} lit={chosen === source.messageId} conversationId={conversationId} panel={panel} onOpen={() => (open ? open(source, n) : void showSource(source, n, queries))} />;
  };
  // plan 162 (after ai162-r03): a claim with no citation is marked where it is. After ai162-r05: in the ink, as every
  // claim, followed by a mark that says it in words, "no source", where a citation would be (grey alone asked the reader
  // to compare shades, and grey means secondary everywhere else: six reports; an underline read as a link: five)
  const sentences = (part: string) =>
    answerSentences(part).map((sentence, k) => {
      const runs = boldParts(sentence.text.trimEnd()).map((b, j) => (b.bold ? <strong key={j} className="font-semibold"><Runs text={b.text} marker={marker} /></strong> : <Runs key={j} text={b.text} marker={marker} />));
      const space = sentence.text.slice(sentence.text.trimEnd().length);
      return sentence.claim && !sentence.linked && unlinked ? (
        <span key={k}>
          <span data-testid="ask-unlinked">{runs}</span>
          <span className="whitespace-nowrap">
            {"\u00a0"}
            <span data-testid="ask-unlinked-mark" title={t("ask.unlinked.tip")} className="inline-flex h-[1.4em] items-center rounded-[0.4em] border border-dashed border-border px-[0.4em] align-[0.05em] text-xs leading-none text-muted-foreground">{t("ask.unlinked.mark")}</span>
          </span>
          {space}
        </span>
      ) : (
        <span key={k}>{runs}{space}</span>
      );
    });
  // after ai162-r04: the model's "- " and "1. " lines are a list (they showed as raw hyphens); a blank line a paragraph
  return (
    <div ref={answerRef} className="space-y-2 break-words text-sm leading-relaxed" data-testid="ask-answer">
      {answerBlocks(cleanAnswer(text)).map((b, i) =>
        b.kind === "p" ? (
          <p key={i} className="whitespace-pre-wrap">{sentences(b.text)}</p>
        ) : (
          <List key={i} kind={b.kind}>
            {b.items.map((item, j) => <li key={j} className="ps-0.5" data-testid="ask-answer-item">{sentences(item)}</li>)}
          </List>
        ),
      )}
    </div>
  );
}

/** One citation: the number on its word, a button to its source; a source already read says so to screen readers (plan 165). */
function Citation({ source, n, lit, conversationId, panel, onOpen }: { source: AskSourceRef; n: number; lit: boolean; conversationId: number | null; panel: Element | null; onOpen: () => void }) {
  const visited = useVisited(conversationId, source.messageId);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="ask-citation"
            data-lit={lit || undefined}
            data-visited={visited || undefined}
            onKeyDown={stopKeys}
            onClick={onOpen}
            className="group/cite relative z-[1] -my-1 ms-px -me-1 inline-flex size-6 items-center justify-center rounded-md align-[0.05em] outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t(visited ? "ask.citationVisited" : "ask.citation", { n, subject: source.subject })}
          />
        }
      >
        <span aria-hidden className={cn(CITE_PILL, "transition-colors duration-fast", lit ? "bg-primary/15" : "bg-field group-hover/cite:bg-muted")}>{n}</span>
      </TooltipTrigger>
      {/* plan 162 (after ai162-r05): below its mark, from its start, inside the panel (above, it covered the question
          and spilled past the panel's edge) */}
      <TooltipContent side="bottom" align="start" collisionBoundary={panel ?? undefined} collisionPadding={12} data-testid="ask-citation-preview">
        <span className="block font-medium">{source.subject || t("common.noSubject")}</span>
        <span className="block">{sourceLine(source)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function List({ kind, children }: { kind: "ul" | "ol"; children: ReactNode }) {
  const cls = "space-y-1 ps-5 marker:text-muted-foreground";
  return kind === "ol" ? <ol className={cn(cls, "list-decimal")} data-testid="ask-answer-list">{children}</ol> : <ul className={cn(cls, "list-disc")} data-testid="ask-answer-list">{children}</ul>;
}

/** An answer's words with their citations bound to the word before them (`citationRuns`); `marker` draws a citation. */
function Runs({ text, marker }: { text: string; marker: (n: number, key: number) => ReactNode }) {
  return citationRuns(text).map((run, i) =>
    "text" in run ? (
      <span key={i}>{run.text}</span>
    ) : (
      <span key={i} className="whitespace-nowrap" data-testid="ask-cited">
        {run.lead}
        {run.cites.map((n, j) => marker(n, j))}
        {run.trail}
      </span>
    ),
  );
}

/** a citation's number as a mark: the button's pill, and while the answer streams the mark alone (its source comes at the end) */
const CITE_PILL = "inline-grid h-[1.5em] min-w-[1.5em] place-items-center rounded-[0.4em] px-[0.3em] text-2xs leading-none font-semibold text-foreground tabular";
const streamingMark = (n: number, key: number) => (
  <span key={key} aria-hidden data-testid="ask-streaming-cite" className="relative -my-1 ms-px -me-1 inline-flex size-6 items-center justify-center align-[0.05em]">
    <span className={cn(CITE_PILL, "bg-field")}>{n}</span>
  </span>
);

/** Plan 162 (after ai162-r03): marked inline and said once, only when the answer holds a claim no source backs (a stop says Stopped). */
export const unlinkedClaims = (turn: Pick<AskTurn, "answer" | "status">): boolean => turn.status !== "stopped" && answerSentences(cleanAnswer(turn.answer ?? "")).some((s) => s.claim && !s.linked);

/**
 * Plan 162 (after ai162-r03): one first name for several people among the sources, said from their senders. After
 * ai162-r04: said before the answer, where it decides how the answer reads (it came after the merged answer).
 */
export function SameName({ turn }: { turn: AskTurn }) {
  const people = sameNamePeople(turn.sources, turn.question, turn.answer ?? "");
  if (!people.length) return null;
  const list = new Intl.ListFormat(getLocale(), { type: "conjunction" });
  return (
    <div className="space-y-0.5 text-xs text-foreground" data-testid="ask-same-names">
      {people.map((p) => (
        <p key={p.name} data-testid="ask-same-name">{t("ask.sameName", { name: p.name, count: p.people.length, people: list.format(p.people) })}</p>
      ))}
    </div>
  );
}

export function Checks({ turn }: { turn: AskTurn }) {
  const { unsupported } = turn.checks;
  if (!unsupported.length) return null;
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="ask-checks">
      {unsupported.map((value) => (
        <p key={value} data-testid="ask-check-unsupported" className="text-destructive-ink">{t("ask.check.unsupported", { value })}</p>
      ))}
    </div>
  );
}

/** A source asked for once, now in Spam or Trash: said where the citation is, since a row may be further down, or absent. */
export function Armed({ sources }: { sources: readonly AskSourceRef[] }) {
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
      {turn.answer && <SameName turn={turn} />}
      {turn.answer ? <AnswerText text={turn.answer} sources={turn.sources} queries={turn.queries} chosen={last ? chosen : null} unlinked={unlinkedClaims(turn)} conversationId={turn.conversationId} /> : null}
      <Armed sources={turn.sources} />
      {turn.status === "stopped" && <p className="text-xs text-muted-foreground" data-testid="ask-stopped">{t("ask.stopped")}</p>}
      <Checks turn={turn} />
      {turn.answer && (
        // plan 161, pass 2: buttons that look like buttons, their edge on the answer's
        <div className="flex items-center gap-1 pt-0.5 text-xs text-muted-foreground" data-testid="ask-turn-actions">
          {/* plan 161, pass 3: the one Copy and the one "Written with AI ▾" every AI surface has. Plan 162: both utilities
              quiet, at the row's 28 px, the first glyph on the answer's edge, as the summary's */}
          <AiCopyButton className="-ms-2" text={() => answerWithoutCitations(turn.answer ?? "")} failed={t("ask.copyFailed")} testId="ask-copy" onKeyDown={stopKeys} />
          {last && !running && (
            // it asks the same question once more; the new answer comes under this one
            <Button variant="ghost" size="sm" className="px-2 text-muted-foreground hover:text-foreground" data-testid="ask-again" onKeyDown={stopKeys} onClick={() => askQuestion(turn.question)}><RefreshCw aria-hidden /> {t("ask.again")}</Button>
          )}
          <AiProvenance model={turn.model ?? ""} at={turn.createdAt} testId="ask-provenance" className="ml-auto" onKeyDown={stopKeys} />
        </div>
      )}
      {last && turn.answer && <Scope />}
      {/* plan 161, pass 2: what an earlier turn cited stays under it (the last turn's are the palette's rows, once nothing
          is being answered under it) */}
      {(!last || running) && turn.sources.length > 0 && <TurnSources sources={turn.sources} queries={turn.queries} />}
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

function CommandNotice({ echo = true }: { /** plan 162: not under the field that holds the same words */ echo?: boolean }) {
  const notice = useAsk((s) => s.notice);
  if (!notice) return null;
  return (
    <section className="space-y-1" data-testid="ask-command-notice">
      <h3 className={echo ? "text-xs font-medium text-muted-foreground" : "sr-only"} data-testid="ask-question">{notice.question}</h3>
      <p className="text-sm">{notice.text}</p>
    </section>
  );
}

/**
 * The notice above the empty page's rows, or nothing at all: an empty box was still a sibling, so the first group took the
 * next group's top gap and sat 8 px low between the field and the hints (the owner's catch).
 */
function PaddedNotice() {
  const notice = useAsk((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="px-[18px] py-2">
      <CommandNotice echo={false} />
    </div>
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
      <span>{t("ask.scope", { date: boundaryDay(since) })}</span>
      {/* plan 161, pass 3: after an answer, the way past it is a quiet link in the scope's line, below the answer and its sources in weight */}
      {offer.kind === "offline" ? <span data-testid="ask-older-offline">{t("ask.older.offline")}</span> : (
        <OlderButton />
      )}
    </p>
  );
}

/**
 * Plan 161, pass 2: older mail when nothing here answers. Plan 162 (after ai162-r01): one control wherever it shows, a quiet
 * button with its glyph (it was bold text under an answer and an outlined button under a miss).
 */
function OlderButton() {
  return (
    <Button variant="ghost" size="xs" className="-ms-1.5 font-medium text-muted-foreground hover:text-foreground" data-testid="ask-older" onKeyDown={stopKeys} onClick={searchOlder}>
      <Search /> {t("ask.older.servers")}
    </Button>
  );
}

/** IMAP's search may miss other cases and accents, and a deadline may have left folders out. */
function OlderLimit() {
  const partial = useAsk((s) => s.olderPartial);
  return partial ? <p className="text-xs text-muted-foreground" data-testid="ask-older-partial">{t("ask.older.partial")}</p> : null;
}

function Running({ ref }: { ref?: React.Ref<HTMLElement> }) {
  const running = useAsk((s) => s.running);
  // plan 162 (after ai162-r05): a follow-up's question heads its answer from the start, as it will once done (the header
  // holds only the first's place alone)
  const alone = useAsk((s) => s.turns.length === 0);
  if (!running) return null;
  const { older, searchingOlder, text, chunks, question } = running;
  const looking = searchingOlder && !text ? (older ? t("ask.older.progress", { done: older.done, total: older.total }) : t("ask.older.looking")) : t("ask.looking");
  return (
    <section ref={ref} className="space-y-1.5" data-testid="ask-running">
      <h3 className={alone ? "sr-only" : "text-sm font-medium"} data-testid="ask-question">{question}</h3>
      {text ? (
        // plan 162 (after ai162-r03): its citations as the marks they'll be, never "[1]" until the end
        // the owner (2026-11-08): "a nice fading animation that brings the words": each piece fades in as it arrives (CSS on
        // its own span, at the motion cap; none when motion is off or reduced), and what came before stays as it was
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="ask-streaming">
          {chunks.map((chunk, i) => (
            <span key={i} data-testid="ask-chunk" className="animate-in fade-in-0 duration-slow ease-motion">
              {chunk.split(/(\[\d+\])/).map((part, j) => (/^\[\d+\]$/.test(part) ? streamingMark(Number(part.slice(1, -1)), j) : part))}
            </span>
          ))}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-looking">
          <Spinner className="size-3.5" /> {looking}
        </p>
      )}
      <Button variant="link-secondary" size="xs" data-testid="ask-stop" onKeyDown={stopKeys} onClick={() => stopAsking()}>{t("ask.stop")}</Button>
    </section>
  );
}

/** Plan 162: Ask's failure in the one AI error's words, from the task's own provider, its catalog key kept (Codex review). */
export function askErrorCopy(error: { message: string; kind: AiErrorKind | undefined; key?: string | undefined }, ai: AiSettings | null | undefined): AiErrorCopy {
  return aiErrorCopy({ message: error.message, kind: error.kind, key: error.key }, ai ? errorTarget(askTarget(ai).provider, ai) : null);
}

function Failure() {
  const error = useAsk((s) => s.error);
  const ai = useApp((s) => s.settings?.ai);
  if (!error) return null;
  // plan 162: the one AI error every surface has (ai-error.tsx): plain words, never an address, Try again and AI settings
  const copy = askErrorCopy(error, ai);
  return (
    <section data-testid="ask-error">
      <AiErrorNotice
        copy={copy}
        textTestId="ask-error-text"
        actions={
          <>
            <Button size="sm" variant="outline" data-testid="ask-retry" onKeyDown={stopKeys} onClick={() => askQuestion(error.question)}>{t("ask.tryAgain")}</Button>
            {copy.settings && (
              <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" data-testid="ask-error-settings" onKeyDown={stopKeys} onClick={() => setApp({ dialog: "settings", settingsTab: "ai" })}>{t("ai.error.settings")}</Button>
            )}
          </>
        }
      />
    </section>
  );
}

/** A source's number, sender, subject (or where it went) and date: a palette row's, and an earlier turn's alike. */
function SourceCells({ source, n }: { source: AskSourceRef; n: number }) {
  const view = useAsk((s) => s.sources[source.messageId]?.state ?? "ok");
  const armed = useAsk((s) => s.armedSource === source.messageId);
  const visited = useVisited(useAsk((s) => s.conversationId), source.messageId);
  const moved = view === "spam" || view === "trash";
  return (
    <>
      {/* the inline marker's look, so a citation and its row read as one number */}
      <span className="w-5 shrink-0"><span data-testid="ask-source-n" className="inline-grid h-[1.4em] min-w-[1.4em] place-items-center rounded-[0.4em] bg-field px-[0.3em] text-2xs leading-none font-semibold text-foreground tabular">{n}</span></span>
      {/* plan 162 (after ai162-r04): room for a full name where several people share a first one ("Isabella Cruz (Nóm…").
          Plan 165: a source already read goes to the secondary ink, as a visited link does */}
      <span className={cn("w-40 shrink-0 truncate", visited && "text-muted-foreground")} title={source.fromName || source.fromEmail}>{source.fromName || source.fromEmail}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{view === "gone" ? t("ask.source.gone") : moved ? t(armed ? "ask.source.pressAgain" : view === "spam" ? "ask.source.spam" : "ask.source.trash") : source.subject}</span>
      <CommandDescription>{listDate(source.date)}</CommandDescription>
      <Visited visited={visited} />
    </>
  );
}

/**
 * Plan 165: a source already read (shown in Ask, or opened in the reader) ends its row with a quiet check, in a slot every
 * row keeps so the dates stay one column; screen readers hear "opened".
 */
export function Visited({ visited }: { visited: boolean }) {
  return (
    <span className="-ms-1 flex w-3.5 shrink-0 justify-end text-muted-foreground" data-testid={visited ? "ask-source-visited" : undefined}>
      {visited && (
        <>
          <Check aria-hidden className="size-3.5" />
          <span className="sr-only">{t("ask.source.visited")}</span>
        </>
      )}
    </span>
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
  // plan 162 (after ai162-r03): folded to their count, so an earlier turn's rows never stand alone at the top of the answers
  return (
    <Collapsible data-testid="ask-turn-sources">
      <CollapsibleTrigger onKeyDown={stopKeys} data-testid="ask-turn-sources-toggle" className="h-6 w-auto gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&>[data-slot=collapsible-chevron]]:ms-0 [&>[data-slot=collapsible-chevron]]:size-3.5">
        {t("ask.sourcesCount", { count: sources.length })}
      </CollapsibleTrigger>
      <CollapsiblePanel>
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
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Plan 161, pass 3: the way back to all commands, as words that say so, and a plain close. In place of the page chip,
 * whose × read as close.
 */
/** Plan 162: the way back is All commands only when Ask was opened from them; from ⌘⇧K there's nothing behind it but the mail. */
function AskNav({ onBack, onClose, pin }: { onBack: () => void; onClose: () => void; /** plan 165: an answer that can be pinned */ pin?: ReactNode }) {
  // where one step back goes from here: All commands, Ask (from its history), or nowhere but the mail (the ×)
  const to = usePalettePage((s) => paletteBack(s.page, s.entry));
  return (
    <span className="flex shrink-0 items-center gap-1.5" data-testid="ask-nav">
      {pin}
      {to !== null && (
        <Button variant="ghost" size="xs" className="font-medium text-muted-foreground" data-testid="palette-back" onKeyDown={stopKeys} onClick={onBack}>
          <ChevronLeft /> {to === "root" ? t("ask.allCommands") : t("palette.ask.page")}
        </Button>
      )}
      <CloseButton size="sm" data-testid="ask-close" onKeyDown={stopKeys} onClick={onClose} />
    </span>
  );
}

/**
 * Plan 165: the answer showing, pinned to the reading pane's corner, so its sources can be read one after another with
 * it in view. Pressed while this answer is the one pinned: a press takes the card away.
 */
function PinAnswer({ turn }: { turn: AskTurn }) {
  const pinned = usePinnedAsk((s) => s.pinned?.turn.id === turn.id);
  const label = t(pinned ? "ask.unpin" : "ask.pin");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label={label} aria-pressed={pinned} data-testid="ask-pin" onKeyDown={stopKeys} onClick={() => (pinned ? unpinAnswer({ toAsk: false }) : pinAnswer())} className="text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-primary [&_svg]:size-3.5">
            <Pin />
          </Button>
        }
      />
      <TooltipContent className="max-w-64 flex-col items-start gap-0.5 text-left">
        <span className="font-medium">{label}</span>
        {!pinned && <span className="text-muted-foreground">{t("ask.pinTip")}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Plan 161, pass 3: what the keys do where you are, never a promise they don't keep. */
type Where = "empty" | "asking" | "walking" | "peek";
function AskHints({ where, sources, end }: { where: Where; /** how many the answer has: ↓ says it (plan 162, after ai162-r04) */ sources: number; end?: ReactNode }) {
  const running = useAsk((s) => s.running !== null);
  const back = usePalettePage((s) => s.entry !== "ask");
  // plan 162: one way back on screen. From the palette, All commands is the header's link, so the keys don't repeat it;
  // from ⌘⇧K, Esc closes and says so; while it answers, Esc stops
  const esc = running ? [{ keys: ["escape"], label: t("ask.stop") }] : back ? [] : [{ keys: ["escape"], label: t("common.close") }];
  const hints =
    where === "peek"
      ? [{ keys: ["enter"], label: t("ask.peek.open") }, { keys: ["escape"], label: t("ask.peek.back") }]
      : where === "walking"
        ? [{ keys: ["arrowup", "arrowdown"], label: t("ask.keys.sources") }, { keys: ["enter"], label: t("ask.keys.show") }, ...esc]
        : [{ keys: ["enter"], label: t("ask.keys.ask") }, ...(sources > 0 && where === "asking" ? [{ keys: ["arrowdown"], label: t("ask.keys.sourcesCount", { count: sources }) }] : []), ...esc];
  return <CommandHints hints={hints} end={end} data-testid="ask-hints" data-where={where} />;
}

/** The page's own keys: Esc stops first, the follow-up box types, arrows walk the sources (and say so below). */
function FollowUp({ disabled, onWalk, inputRef: ref }: { disabled: boolean; onWalk: (walking: boolean) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  // plan 165: a follow-up half typed when a source or a pin closed the dialog is there when it comes back
  const conversationId = useAsk((s) => s.conversationId);
  const [value, setTyped] = useState(() => askPlace(conversationId)?.followUp ?? "");
  const setValue = (text: string) => {
    setTyped(text);
    keepAskPlace(conversationId, { followUp: text });
  };
  const running = useAsk((s) => s.running !== null);
  const armed = useRef(false);
  // plan 162 (Codex review): a follow-up that failed or found nothing keeps its words here too, selected, unless typed over
  const missed = useAsk((s) => s.error?.question ?? s.notice?.question ?? null);
  useEffect(() => {
    if (missed === null || value !== "") return;
    setValue(missed);
    requestAnimationFrame(() => ref.current?.select());
  }, [missed]);
  useLayoutEffect(() => ref.current?.focus(), []);
  const walk = (on: boolean) => {
    armed.current = on;
    onWalk(on);
  };
  return (
    <div className="shrink-0 border-t border-border/60 px-[18px] py-2">
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
      className="flex min-h-0 flex-col"
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
        className="max-h-80 min-h-0 space-y-3 overflow-y-auto px-[18px] pt-2 pb-3 outline-none"
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
  // plan 162 (after ai162-r01): the question being answered now, not the conversation's first (a follow-up kept the old one)
  const title = running?.question ?? turns.at(-1)?.question ?? "";
  const last = turns.at(-1);
  const conversationId = useAsk((s) => s.conversationId);
  const area = useRef<HTMLDivElement>(null);
  const followUp = useRef<HTMLInputElement>(null);
  // plan 162 (after ai162-r03): a turn starts at its top. When a question is asked (or Ask opens on an answer), its
  // question goes to the top of the one scroll region and stays there while the answer streams under it: a long answer
  // starts at its beginning, and an earlier turn's sources are never what's left on top
  const runningRef = useRef<HTMLElement>(null);
  const toTop = (el: HTMLElement | null) => {
    const box = area.current;
    if (box && el) box.scrollTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
  };
  // Codex review: held there as the answer grows (at first the region can't scroll that far: the short "Looking…" under
  // a long answer), and once it's done, on its turn, until the user scrolls it themselves
  const pinned = useRef(false);
  const lastTurn = () => [...(area.current?.querySelectorAll<HTMLElement>("[data-testid=ask-turn]") ?? [])].at(-1) ?? null;
  useLayoutEffect(() => {
    if (running) {
      pinned.current = true;
      toTop(runningRef.current);
    } else if (pinned.current) toTop(lastTurn());
  }, [running?.requestId]);
  useLayoutEffect(() => {
    if (running && pinned.current) toTop(runningRef.current);
  }, [running?.text.length]);
  const sourcesRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (running) return;
    // plan 165: back on the same answer (a source read, ⇧⌘K, Back to the answer, Unpin), it's where it was read to, its
    // sources where they were scrolled to; an answer come since starts at its top, as ever
    const place = askPlace(conversationId);
    const box = area.current;
    if (!box || place?.turns !== turns.length) return toTop(lastTurn());
    box.scrollTop = place.top;
    if (sourcesRef.current) sourcesRef.current.scrollTop = place.sourcesTop;
  }, []);
  const keep = (patch: { top?: number; sourcesTop?: number }) => keepAskPlace(conversationId, { ...patch, turns: turns.length });
  // the row chosen with ↑↓, for the palette's next opening on this answer (`askChosen`)
  const chosenValue = useCommandState((state) => state.value);
  useEffect(() => {
    if (!running && chosenValue?.startsWith("source\u0000")) keepAskPlace(conversationId, { chosen: chosenValue, turns: turns.length });
  }, [chosenValue]);
  const unpin = () => { pinned.current = false; };
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
  const sourceCount = running ? 0 : (last?.sources.length ?? 0);
  const sources = sourceCount > 0;
  // plan 161, pass 3: starting over and the history are quiet controls at the end of the keys' line, not rows of their own
  const session = !peek && (
    // plan 162: starting over and the history are places, not keys: apart from them, after a divider
    <span className="flex items-center gap-0.5 border-s border-border/60 ps-1.5" data-testid="ask-session">
      <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" data-testid="ask-new" onKeyDown={stopKeys} onClick={() => newQuestion()}>
        <Plus /> {t("ask.new")}
      </Button>
      <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" data-testid="ask-history-row" onKeyDown={stopKeys} onClick={() => setPalettePage("askHistory")}>
        <Clock /> {t("palette.askHistory")}
      </Button>
    </span>
  );
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 ps-3 pe-2.5 text-sm" data-testid="ask-header">
        <Sparkles className="size-[1.15em] shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" data-testid="ask-title">{title}</span>
        <AskNav onBack={onBack} onClose={onClose} pin={!peek && !running && conversationId !== null && last?.kind !== "command" && last?.answer ? <PinAnswer turn={last} /> : null} />
      </div>
      {peek && <PeekView peek={peek} />}
      {/* under a shown source, out of sight, reach and the accessibility tree, but kept: not unmounted */}
      {/* plan 162 (after ai162-r04): the dialog is a column bounded by the window; this part gives up height first, so the
          header, the follow-up box and the keys' line are always whole (it ran past a 1100x700 window) */}
      <div inert={peek !== null} className={cn("flex min-h-0 flex-col", peek && "invisible h-0 overflow-hidden")} data-testid="ask-conversation">
          {/* tabbable: it scrolls, and a keyboard has to reach what it holds. Plan 162 (after ai162-r05): the answer's
              region; its sources are apart, under it (one region left a long answer one half-faded source row at
              1100x700), and nothing fades: the hairline over the sources is the edge */}
          <div ref={area} tabIndex={0} data-testid="ask-area" onWheel={unpin} onPointerDown={unpin} onKeyDown={unpin} onScroll={(e) => keep({ top: e.currentTarget.scrollTop })} className="max-h-[30rem] min-h-0 flex-1 overflow-y-auto outline-none">
            <div className="space-y-4 px-[18px] py-3">
              {turns.map((turn) => (
                turn.kind === "command" ? <CommandTurn key={turn.id} turn={turn} last={turn === last} /> : <Turn key={turn.id} turn={turn} last={turn === last} repeated={turns.length === 1 && !running && turn.question === title} />
              ))}
              <Running ref={runningRef} />
              <Failure />
              <CommandNotice />
              <Older />
              {incomplete && <p className="text-xs text-muted-foreground" data-testid="ask-incomplete">{t("ask.incomplete")}</p>}
              <OlderLimit />
            </div>
          </div>
          {last && sources && !running && (
            // plan 162 (after ai162-r05): always on screen, three whole rows under their count (28 px heading, 32 px rows,
            // 2 px gaps, 6 px foot); more scroll here, the heading staying, and ↑↓ bring the chosen row whole into view
            <CommandList ref={sourcesRef} onScroll={(e) => keep({ sourcesTop: e.currentTarget.scrollTop })} label={t("ask.sources")} data-testid="ask-sources" className="max-h-[8.375rem] shrink-0 overflow-y-auto border-t border-border/60 px-1.5 pt-0 pb-1.5 **:[[cmdk-group-heading]]:top-0">
              <CommandGroup heading={t("ask.sourcesCount", { count: last.sources.length })} data-group="ask-sources">
                {last.sources.map((source, i) => (
                  <SourceRow key={source.messageId} source={source} n={i + 1} queries={last.queries} />
                ))}
              </CommandGroup>
            </CommandList>
          )}
          <FollowUp disabled={atLimit || !enabled} onWalk={setWalking} inputRef={followUp} />
      </div>
      <AskHints where={peek ? "peek" : walking && chosen !== null ? "walking" : "asking"} sources={sourceCount} end={session} />
    </>
  );
}

/** No question yet: the palette's own input, and Enter on a row. */
function Empty({ value, setValue, onBack, onClose }: { value: string; setValue: (v: string) => void; onBack: () => void; onClose: () => void }) {
  const running = useAsk((s) => s.running);
  const error = useAsk((s) => s.error);
  const notice = useAsk((s) => s.notice);
  const query = value.trim();
  const busy = running !== null || error !== null;
  // plan 162 (after ai162-r01): a request that found nothing, or failed, keeps its words in the field, selected, to change
  // or send again (they were cleared, so the user retyped them)
  const missed = notice?.question ?? error?.question ?? null;
  useEffect(() => {
    if (missed === null || value !== "") return;
    setValue(missed);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-testid=palette-input]")?.select());
  }, [missed]);
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
          <PaddedNotice />
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
      <AskHints where="empty" sources={0} />
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
  const failed = useAsk((s) => s.error !== null);
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
    // plan 162 (after ai162-r03): ⌘⇧K on a shown source goes back to its answer, as Esc does (it closed Ask)
    paletteKeys.toggle = () => closePeek();
    return () => {
      paletteKeys.escape = null;
      paletteKeys.toggle = null;
      closePeek();
    };
  }, []);
  const content: ReactNode = !ready || noProvider ? <NoProvider /> : hasConversation || running ? <Conversation onBack={onBack} onClose={onClose} /> : <Empty value={value} setValue={setValue} onBack={onBack} onClose={onClose} />;
  return (
    <>
      {content}
      {/* never the deltas: what's underway, and that it's done */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="ask-live">
        {/* plan 162: a failure is the alert's to say, never "Answer ready" */}
        {running ? t("ask.lookingShort") : failed ? "" : announced !== announcedAtOpen.current ? t("ask.ready") : ""}
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


