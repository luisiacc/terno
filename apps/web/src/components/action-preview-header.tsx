import { savesRuleOnly } from "@terno/core";
import type { ThreadSummary } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { AiProvenance } from "./ai-provenance";
import { AiErrorNotice, aiErrorCopy, errorTarget } from "./ai-error";
import { useEffect, type ReactNode } from "react";
import { askTarget } from "~/lib/ai";
import { listDate } from "~/lib/format";
import { boundaryDay } from "~/lib/when";
import { PenLine } from "@terno/ui/icons";
import { applyPreview, check, inboxOnly, includeSkipped, isDestructive, previewConsequence, previewCount, previewTitle, previewWaiting, showLeftOut, stopApplying, useActionPreview, verbOf } from "~/lib/action-preview";
import { useAppearance } from "~/lib/appearance";
import { LIST_TITLE } from "~/lib/list-title";
import { PANE_TITLE, PANE_TITLE_TOP, READING_COLUMN } from "~/lib/pane-lines";
import { hasDetails, patternTerms, ruleDetails, ruleRow, senderNotLooked } from "~/lib/rule-words";
import { isMac } from "~/lib/select";
import { closePreviewRow, focusWhenReady, leavePreview, useActionRows } from "~/state/action-preview";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

const Line = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className="flex flex-wrap items-center gap-x-1.5 text-foreground" data-testid={testId}>
    {children}
  </p>
);

const Dot = () => <span aria-hidden>·</span>;

/**
 * Plan 162 (after ai162-r01): what the search found, from its rows, no model: who sent them (with how many), their dates and
 * the accounts, so the batch can be checked at a glance before Apply. Only when every match is a row here.
 */
export function foundSummary(rows: readonly Pick<ThreadSummary, "fromName" | "fromEmail" | "lastDate" | "accountId">[], accountName: (id: number) => string, now = Date.now()): { from: string; dates: string | null; accounts: string | null } | null {
  if (!rows.length) return null;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const who = r.fromName || r.fromEmail;
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  const senders = [...counts].sort((a, b) => b[1] - a[1]);
  const named = senders.slice(0, 4).map(([who, n]) => (n > 1 ? `${who} (${n})` : who));
  const rest = senders.length - named.length;
  const list = new Intl.ListFormat(getLocale(), { type: "conjunction" });
  const from = list.format(rest > 0 ? [...named, t("action.found.more", { count: rest })] : named);
  const dates = rows.map((r) => r.lastDate).filter((d) => d > 0);
  // plan 162 (after ai162-r02): a span across years says both ("May 11, 2025 to Aug 28, 2026"), never one end's
  const [first, last] = dates.length ? [Math.min(...dates), Math.max(...dates)] : [0, 0];
  const years = dates.length > 0 && new Date(first).getFullYear() !== new Date(last).getFullYear();
  const lo = dates.length ? (years ? boundaryDay(first) : listDate(first, now)) : null;
  const hi = dates.length ? (years ? boundaryDay(last) : listDate(last, now)) : null;
  const accounts = [...new Set(rows.map((r) => r.accountId))].map(accountName).filter(Boolean);
  return { from, dates: lo && hi ? (lo === hi ? lo : t("action.found.range", { from: lo, to: hi })) : null, accounts: accounts.length > 1 ? list.format(accounts) : null };
}

/** "shipped, delivery or tracking", in the user's language: the words, and what joins them */
const termParts = (terms: readonly string[]) => new Intl.ListFormat(getLocale(), { type: "disjunction" }).formatToParts(terms);

/**
 * "a|b|c" with a break allowed after each "|" (and at a space, between words): a long pattern wraps between its
 * alternatives, never inside a word (`break-normal`; one word wider than the column scrolls rather than splits)
 */
const breakAtBars = (pattern: string): ReactNode[] => {
  const parts = pattern.split("|");
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [`${part}|`, <wbr key={i} />] : [part]));
};


/** The folder a move goes to, by its last name. */
function useFolderName(): string {
  return useApp((s) => {
    const a = useActionPreview.getState().preview?.plan.action;
    return a?.type === "moveToFolder" ? (s.folders.find((f) => f.accountId === a.accountId && f.key === a.folder)?.path.at(-1) ?? a.folder) : "";
  });
}

/**
 * Plan 161: where the rule shows. Split's reader has the room while no row is open (a row opened is that mail, checked
 * before Apply); List's one pane has the window's width, so the rule sits under the header.
 */
export function useRuleInReader(): boolean {
  const list = useAppearance((s) => s.layout === "list");
  return useApp((s) => s.actionPreview !== null && !list && s.selectedId === null && s.compose === null);
}

/** Plan 143 §4: the list header's place while a sentence's preview is the list, on its content line. */
export default function ActionPreviewHeader() {
  const preview = useActionPreview((s) => s.preview);
  const sentence = useActionPreview((s) => s.sentence);
  const checking = useActionPreview((s) => s.checking);
  const list = useAppearance((s) => s.layout === "list");
  const ruleInReader = useRuleInReader();
  // while finding, the rows on screen: the count the title can stand behind until the search is done
  const shown = useList((s) => s.items.length);
  const folderName = useFolderName();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(isMac ? e.metaKey : e.ctrlKey) || e.defaultPrevented || getApp().dialog !== null || getApp().menuOpen) return;
      // ⌘↩ in a reply sends the reply: only the list's own focus means Apply
      const at = e.target instanceof Element ? e.target : null;
      if (at?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [data-composer]")) return;
      e.preventDefault();
      void applyPreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // plan 161: ready, the keys are the list's (whatever the palette handed focus back to as it closed), unless you moved
  const ready = preview !== null && !previewWaiting(preview, checking);
  useEffect(() => {
    if (ready && preview) focusWhenReady(preview.previewId);
  }, [ready, preview?.previewId]);

  if (!preview) return null;
  const { plan } = preview;
  const title = previewTitle(preview, shown, folderName);
  // plan 161, pass 2: Split's header holds the count on one line; List's, the window's width and no reader, the outcome
  const heading = list ? title : previewCount(preview, shown);
  return (
    <section data-testid="action-preview" aria-label={t("action.region", { summary: plan.summary })} className="drag-region shrink-0 space-y-1 border-b border-hairline px-5 pt-3 pb-2.5">
      <div className="flex min-h-7 items-center gap-2">
        <h1 data-testid="action-title" className={cn("flex min-w-0 flex-1 items-center gap-2", LIST_TITLE.title)} aria-live="polite">
          <span className={cn("min-w-0", !list && "truncate")} title={heading === title ? undefined : title}>{heading}</span>
        </h1>
        {/* plan 162 (after ai162-r01): the decision has one place, here, whether the rule or a match is in the reader (it
            moved from the rule's foot to here when a match opened) */}
        <ActionButtons size="sm" className="no-drag" escCancels={list || ruleInReader} />
      </div>
      {/* the words typed, when the rule (which they head) isn't on screen */}
      {!ruleInReader && sentence && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="action-sentence">
          <span className="min-w-0 truncate" title={sentence}>“{sentence}”</span>
          {!list && (
            <>
              <Dot />
              {/* plan 162: Esc said once, where it applies: here, while a conversation covers the rule */}
              <Button variant="link-secondary" size="xs" className="no-drag shrink-0 gap-1.5" data-testid="action-show-rule" aria-keyshortcuts="Escape" onClick={() => closePreviewRow()}>{t("action.rule.show")} <Shortcut keys="escape" /></Button>
            </>
          )}
        </p>
      )}
      {list && <ActionRule variant="list" />}
    </section>
  );
}

/**
 * Plan 161, pass 3: Cancel (Stop while applying) and Apply, in one place at a time: the reader's rule while it shows,
 * the header otherwise. Apply waits as a quiet button with a spinner (pass 2), and Trash and Spam are BoardUI's
 * destructive button: a batch that takes mail out of view never looks like an Archive.
 */
function ActionButtons({ size, className, order = "cancel-first", escCancels = true, at }: { size: "sm" | "default"; className?: string; order?: "cancel-first" | "apply-first"; /** Codex review: while a match is read in Split, Esc goes back to the rule, not Cancel */ escCancels?: boolean; /** plan 162 (after ai162-r02): the rule's own copy, its test ids its own */ at?: "rule" }) {
  const id = (name: string) => (at ? `${name}-${at}` : name);
  const preview = useActionPreview((s) => s.preview);
  const checking = useActionPreview((s) => s.checking);
  const applying = useActionPreview((s) => s.applying);
  if (!preview) return null;
  const { count } = preview;
  const verb = verbOf(preview);
  const ruleOnly = savesRuleOnly(preview);
  const waiting = previewWaiting(preview, checking);
  const label = ruleOnly ? t("action.rule.save") : waiting ? t(`action.button.${verb}`) : t(`action.apply.${verb}`, { count });
  // a rule that will trash or spam new mail is as destructive as a batch (Codex review, pass 3, #7)
  const variant = waiting && !applying ? "secondary" : isDestructive(preview) ? "destructive" : "default";
  // plan 162 (after ai162-r01): the keys are the buttons' own, in their tooltips and names (a line under them repeated both)
  const keyed = (button: React.ReactElement, keys: string, name: string) => (
    <Tooltip key={button.key}>
      <TooltipTrigger render={button} />
      <TooltipContent className="flex items-center gap-1.5">{name} <Shortcut keys={keys} /></TooltipContent>
    </Tooltip>
  );
  const cancel = applying ? (
    <Button key="cancel" size={size} variant="secondary" className={className} data-testid={id("action-stop")} onClick={stopApplying}>{t("action.stop")}</Button>
  ) : (
    escCancels ? keyed(<Button key="cancel" size={size} variant="secondary" className={className} data-testid={id("action-cancel")} aria-keyshortcuts="Escape" onClick={leavePreview}>{t("common.cancel")}</Button>, "escape", t("common.cancel")) : <Button key="cancel" size={size} variant="secondary" className={className} data-testid={id("action-cancel")} onClick={leavePreview}>{t("common.cancel")}</Button>
  );
  const applyButton = (
    <Button key="apply" size={size} variant={variant} className={cn(className, "tabular")} data-testid={id("action-apply")} data-variant={variant} data-waiting={waiting || undefined} aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"} disabled={waiting || applying || (count === 0 && !ruleOnly)} onClick={() => void applyPreview()}>
      {waiting && <Spinner data-testid={id("action-finding")} className="size-3.5" />}
      {label}
    </Button>
  );
  const apply = waiting || applying ? applyButton : keyed(applyButton, "mod+enter", label);
  return order === "apply-first" ? [apply, cancel] : [cancel, apply];
}

/**
 * Plan 161: the rule in words. The request as its title, then what Terno read it as, a row a condition (a pattern of
 * plain words as chips), Details with the exact rule, and everything else that decides what Apply does.
 */
export function ActionRule({ variant }: { variant: "reader" | "list" }) {
  const preview = useActionPreview((s) => s.preview);
  const sentence = useActionPreview((s) => s.sentence);
  const future = useActionPreview((s) => s.future);
  const checking = useActionPreview((s) => s.checking);
  const checkError = useActionPreview((s) => s.checkError);
  const senders = useActionPreview((s) => s.senders);
  const leftOutShown = useActionRows((s) => s.showLeftOut);
  const unticked = useActionRows((s) => s.unticked);
  const ai = useApp((s) => s.settings?.ai);
  const accounts = useApp((s) => s.accounts);
  const folderName = useFolderName();
  const shown = useList((s) => s.items.length);
  const items = useList((s) => s.items);
  if (!preview) return null;
  const { plan, count } = preview;
  const ruleOnly = savesRuleOnly(preview);
  const waiting = previewWaiting(preview, checking);
  const accountEmail = (id: number) => accounts.find((a) => a.id === id)?.email ?? "";
  const conditions = future ? preview.keepConditions : plan.conditions;
  const rows = [{ label: t("action.rule.where"), text: t(inboxOnly(preview) ? "action.in.inbox" : "action.in.everywhere") }, ...conditions.map((c) => ruleRow(c, accountEmail))];
  const editAsFilter = () => {
    if (plan.action.type === "createCategory") return;
    const { action } = plan;
    const act = action.type === "moveToCategory" ? { type: "addCategory" as const, categoryId: action.categoryId } : action.type === "moveToFolder" ? { type: "moveToFolder" as const, accountId: action.accountId, folder: action.folder } : { type: action.type };
    // a rule can't say where it looks: the builder says what the preview found, and where, beside its own count
    const where = t(inboxOnly(preview) ? "action.in.inbox" : "action.in.everywhere");
    setApp({ dialog: "filters", filterPrefill: { name: plan.summary, rule: { match: "all", conditions: preview.keepConditions, actions: [act] }, source: "ai", note: waiting ? undefined : t("filters.preview.fromAction", { count, where }) } });
  };
  // plan 162: the one provenance control, at the end of the rule's line, as every AI result has: the model read the request
  // into this rule (the plan doesn't carry which model, so it says what it did and how to check it)
  const provenance = <AiProvenance model="" at={0} lines={[t("action.provenance")]} testId="action-provenance" className="-me-1.5 ms-auto no-drag" />;
  const reader = variant === "reader";
  // plan 161, pass 3: a large or destructive batch says what it'll do, in words, before anything else about the rule
  const said = waiting ? null : previewConsequence(preview, folderName);
  const consequence = said && (
    <p data-testid="action-consequence" data-destructive={said.destructive || undefined} className={cn("text-pretty", reader ? "mt-2 text-sm" : "text-xs", said.destructive ? "font-medium text-destructive-ink" : "text-foreground")}>
      {said.text}
    </p>
  );
  // plan 161 (the owner): a sender the sentence names for certain, and a rule that doesn't look at who sent it: said
  // calmly, beside the rule, without a model; Apply is as it was
  const notLooked = senderNotLooked(conditions, senders);
  // plan 162 (after ai162-r01): the exact search only when it says more than the words above (a list of words read as a regex)
  const details = hasDetails(conditions) ? ruleDetails(conditions).filter((d) => patternTerms(d.pattern) === null) : [];
  const senderLine = notLooked && (
    <p data-testid="action-sender" className={cn("text-pretty text-foreground", reader ? "text-sm" : "text-xs")}>
      {t("action.sender.notLooked", { name: notLooked })}
    </p>
  );
  // what Apply takes: the ticked rows, when every match is a row here
  const ticked = items.filter((r) => !unticked.has(r.id));
  const found = !waiting && !ruleOnly && count > 0 && ticked.length === count ? foundSummary(ticked, (id) => { const a = accounts.find((x) => x.id === id); return a ? a.displayName || a.email : ""; }) : null;
  const editLink = plan.action.type !== "createCategory" && (
    // plan 162 (after ai162-r02): a control that looks like one, beside what it edits (grey text, it read as a caption)
    <Button variant="outline" size={reader ? "sm" : "xs"} className="no-drag shrink-0 text-foreground" data-testid="action-edit-filter" onClick={editAsFilter}>
      <PenLine aria-hidden />
      {t("action.editAsFilter")}
    </Button>
  );
  // the owner (2026-11-08): "not clear at all, i don't understand what i need to do there, too much text that's very not
  // important". What will happen leads (the title, then which mail, in one line), then what's kept back when it changes
  // the decision, then the decision itself; how Terno read the request is one quiet disclosure, closed
  const foundText = found ? [found.from, found.dates, found.accounts].filter(Boolean).join(" · ") : null;
  const anyFact = plan.action.type === "createCategory" || preview.hidden || preview.forwards || preview.skipped > 0 || checking || checkError || preview.leftOut + preview.unchecked > 0 || (preview.keep.kind !== "hidden" && !ruleOnly);
  const reading = (
    <Collapsible data-testid="action-reading" className="hairline-t pt-2">
      <div className="flex flex-wrap items-center gap-x-4">
        <CollapsibleTrigger className="h-7 w-auto gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&>[data-slot=collapsible-chevron]]:ms-0 [&>[data-slot=collapsible-chevron]]:size-3.5" data-testid="action-reading-toggle">
          {t("action.reading")}
        </CollapsibleTrigger>
        {provenance}
      </div>
      <CollapsiblePanel>
        <div className={cn("flex flex-col gap-3 pt-2 pb-1", reader ? "text-sm" : "text-xs")}>
          <dl data-testid="action-conditions" className={cn("grid grid-cols-[minmax(5rem,max-content)_1fr] items-baseline gap-x-4", reader ? "gap-y-2" : "gap-y-1")}>
            {rows.map((r, i) => (
              <div key={i} className="contents" data-testid="action-rule-row">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="min-w-0 text-pretty wrap-anywhere">
                  <span>{r.text}</span>
                  {r.terms && " "}
                  {r.terms && termParts(r.terms).map((part, j) => (part.type === "element" ? <span key={j} data-testid="action-rule-term" className="font-medium">{part.value}</span> : <span key={j}>{part.value}</span>))}
                </dd>
              </div>
            ))}
          </dl>
          {details.length > 0 && (
            <div data-testid="action-details">
              <h4 className="text-xs font-medium text-muted-foreground">{t("action.rule.exact")}</h4>
            <dl className="mt-1 grid grid-cols-[minmax(5rem,max-content)_1fr] items-baseline gap-x-4 gap-y-1 text-xs" data-testid="action-details-text">
              {details.map((d, i) => (
                <div key={i} className="contents">
                  <dt className="text-muted-foreground">{d.field}</dt>
                  <dd className="min-w-0 overflow-x-auto break-normal text-foreground" data-testid="action-details-pattern">
                    {d.negate && <span className="text-muted-foreground">{t("filters.op.notMatches")} </span>}
                    {breakAtBars(d.pattern)}
                  </dd>
                </div>
              ))}
            </dl>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">{editLink}</div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
  const body = (
    // (the list's header is a window drag area: what's in it takes clicks)
    <div className={cn("flex flex-col", reader ? "gap-4 text-sm" : "no-drag gap-2.5 pt-1.5 text-xs")}>
      <div className="space-y-1">
        {reader && <h2 className={cn(PANE_TITLE, "text-pretty")} data-testid="action-rule-title">{previewTitle(preview, shown, folderName)}</h2>}
        {/* what was asked, in the user's words: the one line the outcome answers to */}
        {reader && sentence && <p className="text-pretty text-muted-foreground" data-testid="action-rule-request">“{sentence}”</p>}
        {/* which mail, at a glance: who it's from, when, and where (counted from the ticked rows, so an untick recounts it) */}
        {foundText && <p className="text-pretty text-foreground" data-testid="action-found"><span data-testid="action-found-line">{foundText}</span></p>}
        {consequence}
      </div>
      {senderLine}
      {anyFact && (
        <div className="flex flex-col gap-2" data-testid="action-facts">
          {plan.action.type === "createCategory" && <Line testId="action-creates">{t("action.creates", { name: plan.action.name })}</Line>}
          {preview.hidden && <Line testId="action-hidden">{t("action.hidden")}</Line>}
          {preview.forwards && <Line testId="action-forwards">{t("action.forwards")}</Line>}
          {preview.skipped > 0 && (
            <Line testId="action-skipped">
              {t("action.skipped", { count: preview.skipped })} <Dot />
              <Button variant="link-secondary" size="xs" className="no-drag" data-testid="action-include-skipped" onClick={() => void includeSkipped(!preview.skippedIncluded)}>{t(preview.skippedIncluded ? "action.skipped.leave" : "action.skipped.include")}</Button>
            </Line>
          )}
          {checking && <Line testId="action-checking"><Spinner className="size-3" /> {t("action.checking")}</Line>}
          {checkError && (
            // plan 162: the one AI error (ai-error.tsx), keeping the way past a check that keeps failing
            <div className="pt-0.5" data-testid="action-check-error">
              <AiErrorNotice
                copy={aiErrorCopy(checkError, ai ? errorTarget(askTarget(ai).provider, ai) : null)}
                textTestId="action-check-error-text"
                actions={
                  <>
                    <Button size="sm" variant="outline" className="no-drag" data-testid="action-check-retry" onClick={() => void check({})}>{t("ask.tryAgain")}</Button>
                    <Button size="sm" variant="ghost" className="no-drag text-muted-foreground hover:text-foreground" data-testid="action-check-skip" onClick={() => void check({ skip: true })}>{t("action.skipCheck")}</Button>
                  </>
                }
              />
            </div>
          )}
          {preview.leftOut + preview.unchecked > 0 && (
            // plan 162 (after ai162-r03): what the check left out is a decision too: said in the ink, its rows listed
            // (unticked, under the kept ones) once the check is done, and Hide or Show a bordered control
            <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-foreground", reader ? "text-sm" : "text-xs")} data-testid="action-left-out">
              {preview.leftOut > 0 && <span className="font-medium">{t("action.leftOut", { count: preview.leftOut })}</span>}
              {preview.leftOut > 0 && preview.unchecked > 0 && <Dot />}
              {preview.unchecked > 0 && <span data-testid="action-unchecked">{t("action.unchecked", { count: preview.unchecked })}</span>}
              {preview.unchecked > 0 && !checking && <Button variant="link-secondary" size="xs" className="no-drag" data-testid="action-check-more" onClick={() => void check({})}>{t("action.checkMore")}</Button>}
              <Button variant="outline" size="xs" className="no-drag ms-1 text-foreground" data-testid="action-show-left-out" aria-expanded={leftOutShown} onClick={() => showLeftOut(!leftOutShown)}>{t(leftOutShown ? "action.leftOut.hide" : "action.leftOut.show")}</Button>
            </p>
          )}
          {preview.keep.kind !== "hidden" && !ruleOnly && (
            <div>
              <label className="no-drag flex w-fit items-center gap-2 text-xs" data-testid="action-future">
                <Checkbox checked={future} disabled={preview.keep.kind !== "ok"} onCheckedChange={(on) => useActionPreview.setState({ future: on })} data-testid="action-future-box" />
                {t("action.future")}
              </label>
              {future && <p className="text-xs text-muted-foreground" data-testid="action-future-hint">{t("action.future.hint")}</p>}
              {preview.keep.kind === "disabled" && <p className="text-xs text-muted-foreground" data-testid="action-future-reason">{t(preview.keep.reason === "forwarding" ? "action.future.forwarding" : "action.future.exceptions")}</p>}
            </div>
          )}
        </div>
      )}
      {/* the decision, where the reading of the pane ends (the header's own commands, which stay, so nothing moves while a
          match is read) */}
      {reader && (
        <div className="no-drag flex flex-wrap items-center gap-2" data-testid="action-rule-decision">
          <ActionButtons size="sm" at="rule" order="apply-first" />
        </div>
      )}
      {!ruleOnly || plan.conditions.length ? reading : null}
    </div>
  );
  // List: under the header, bounded, so a long rule (Details open) scrolls in place and never takes the rows' room
  // (the request it reads is the header's line above it)
  if (!reader) return <div data-testid="action-rule" className="-mx-5 max-h-[min(40vh,18rem)] overflow-y-auto px-5 pb-0.5">{body}</div>;
  return (
    <section data-testid="action-rule" aria-label={t("action.rule.region")} className="@container h-full min-h-0 bg-background">
      <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
        <div data-reader-column className={cn(READING_COLUMN, PANE_TITLE_TOP, "pb-16")}>{body}</div>
      </div>
    </section>
  );
}
