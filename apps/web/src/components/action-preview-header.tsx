import { savesRuleOnly } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Chip } from "@terno/ui/components/chip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, type ReactNode } from "react";
import { providerLabel } from "~/lib/ai";
import { applyPreview, check, inboxOnly, includeSkipped, isDestructive, previewConsequence, previewCount, previewTitle, previewWaiting, showLeftOut, stopApplying, useActionPreview, verbOf } from "~/lib/action-preview";
import { useAppearance } from "~/lib/appearance";
import { LIST_TITLE } from "~/lib/list-title";
import { PANE_TITLE, PANE_TITLE_TOP, READING_COLUMN } from "~/lib/pane-lines";
import { hasDetails, ruleDetails, ruleRow, senderNotLooked } from "~/lib/rule-words";
import { isMac } from "~/lib/select";
import { closePreviewRow, focusWhenReady, leavePreview, useActionRows } from "~/state/action-preview";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

const Line = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" data-testid={testId}>
    {children}
  </p>
);

const Dot = () => <span aria-hidden>·</span>;

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
        {/* plan 161, pass 3: Apply sits with the rule it applies; here only while the rule isn't on screen */}
        {!ruleInReader && <ActionButtons size="sm" className="no-drag" />}
      </div>
      {/* the words typed, when the rule (which they head) isn't on screen */}
      {!ruleInReader && sentence && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="action-sentence">
          <span className="min-w-0 truncate" title={sentence}>“{sentence}”</span>
          {!list && (
            <>
              <Dot />
              <Button variant="link-secondary" size="xs" className="no-drag shrink-0" data-testid="action-show-rule" onClick={() => closePreviewRow()}>{t("action.rule.show")}</Button>
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
function ActionButtons({ size, className, order = "cancel-first" }: { size: "sm" | "default"; className?: string; order?: "cancel-first" | "apply-first" }) {
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
  const cancel = applying ? (
    <Button key="cancel" size={size} variant="secondary" className={className} data-testid="action-stop" onClick={stopApplying}>{t("action.stop")}</Button>
  ) : (
    <Button key="cancel" size={size} variant="secondary" className={className} data-testid="action-cancel" aria-keyshortcuts="Escape" onClick={leavePreview}>{t("common.cancel")}</Button>
  );
  const apply = (
    <Button key="apply" size={size} variant={variant} className={cn(className, "tabular")} data-testid="action-apply" data-variant={variant} data-waiting={waiting || undefined} aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"} disabled={waiting || applying || (count === 0 && !ruleOnly)} onClick={() => void applyPreview()}>
      {waiting && <Spinner data-testid="action-finding" className="size-3.5" />}
      {label}
    </Button>
  );
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
  const consent = useActionPreview((s) => s.consent);
  const checkError = useActionPreview((s) => s.checkError);
  const senders = useActionPreview((s) => s.senders);
  const leftOutShown = useActionRows((s) => s.showLeftOut);
  const ai = useApp((s) => s.settings?.ai);
  const accounts = useApp((s) => s.accounts);
  const folderName = useFolderName();
  const shown = useList((s) => s.items.length);
  if (!preview) return null;
  const { plan, count } = preview;
  const verb = verbOf(preview);
  const ruleOnly = savesRuleOnly(preview);
  const waiting = previewWaiting(preview, checking);
  const accountEmail = (id: number) => accounts.find((a) => a.id === id)?.email ?? "";
  const conditions = future ? preview.keepConditions : plan.conditions;
  const rows = [{ label: t("action.rule.where"), text: t(inboxOnly(preview) ? "action.in.inbox" : "action.in.everywhere") }, ...conditions.map((c) => ruleRow(c, accountEmail))];
  const label = consent ? providerLabel(consent.provider as Parameters<typeof providerLabel>[0], ai ?? undefined) : "";
  const origin = consent?.provider === "compatible" && consent.endpoint && URL.canParse(consent.endpoint) ? new URL(consent.endpoint).host : null;
  const editAsFilter = () => {
    if (plan.action.type === "createCategory") return;
    const { action } = plan;
    const act = action.type === "moveToCategory" ? { type: "addCategory" as const, categoryId: action.categoryId } : action.type === "moveToFolder" ? { type: "moveToFolder" as const, accountId: action.accountId, folder: action.folder } : { type: action.type };
    // a rule can't say where it looks: the builder says what the preview found, and where, beside its own count
    const where = t(inboxOnly(preview) ? "action.in.inbox" : "action.in.everywhere");
    setApp({ dialog: "filters", filterPrefill: { name: plan.summary, rule: { match: "all", conditions: preview.keepConditions, actions: [act] }, source: "ai", note: waiting ? undefined : t("filters.preview.fromAction", { count, where }) } });
  };
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
  const senderLine = notLooked && (
    <p data-testid="action-sender" className={cn("text-pretty text-foreground", reader ? "text-sm" : "text-xs")}>
      {t("action.sender.notLooked", { name: notLooked })}
    </p>
  );
  const editLink = plan.action.type !== "createCategory" && (
    <Button variant="link-secondary" size="xs" className="no-drag h-6 font-medium" data-testid="action-edit-filter" onClick={editAsFilter}>{t("action.editAsFilter")}</Button>
  );
  const body = (
    // (the list's header is a window drag area: what's in it takes clicks)
    <div className={cn("flex flex-col gap-3", reader ? "text-sm" : "no-drag pt-1.5 text-xs")}>
      {reader ? (
        <div>
          {/* plan 161, pass 2: what Apply does is the title; what was asked, the quieter line under it */}
          <h2 className={cn(PANE_TITLE, "text-pretty")} data-testid="action-rule-title">{previewTitle(preview, shown, folderName)}</h2>
          {sentence && <p className="mt-1 text-sm text-pretty text-muted-foreground" data-testid="action-rule-request">“{sentence}”</p>}
          {consequence}
        </div>
      ) : (
        consequence
      )}
      {senderLine}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("action.rule.readAs")}</h3>
        <dl data-testid="action-conditions" className={cn("mt-1.5 grid grid-cols-[minmax(5rem,max-content)_1fr] items-baseline gap-x-4", reader ? "gap-y-2" : "gap-y-1")}>
          {rows.map((r, i) => (
            <div key={i} className="contents" data-testid="action-rule-row">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1">
                <span>{r.text}</span>
                {r.terms?.map((term) => (
                  <Chip key={term} data-testid="action-rule-term" className="font-normal" title={term}>{term}</Chip>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {hasDetails(conditions) ? (
        <Collapsible data-testid="action-details">
          {/* plan 161, pass 3: Edit as a rule is a quiet link on this line, so the only buttons near the rule are the decision */}
          <div className="flex flex-wrap items-center gap-x-4">
            {/* plan 161, pass 2: named for what it holds, a 24 px target */}
            <CollapsibleTrigger className="h-6 w-auto gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&>[data-slot=collapsible-chevron]]:ms-0 [&>[data-slot=collapsible-chevron]]:size-3.5" data-testid="action-details-toggle">
              {t("action.rule.details")}
            </CollapsibleTrigger>
            {editLink}
          </div>
          <CollapsiblePanel>
            {/* the UI's type, not code's: a pattern breaks only after a "|", never inside a word */}
            <dl className="mt-1 grid grid-cols-[minmax(5rem,max-content)_1fr] items-baseline gap-x-4 gap-y-1 text-xs" data-testid="action-details-text">
              {ruleDetails(conditions).map((d, i) => (
                <div key={i} className="contents">
                  <dt className="text-muted-foreground">{d.field}</dt>
                  <dd className="min-w-0 overflow-x-auto break-normal text-foreground" data-testid="action-details-pattern">
                    {d.negate && <span className="text-muted-foreground">{t("filters.op.notMatches")} </span>}
                    {breakAtBars(d.pattern)}
                  </dd>
                </div>
              ))}
            </dl>
          </CollapsiblePanel>
        </Collapsible>
      ) : (
        editLink && <div>{editLink}</div>
      )}
      {(plan.action.type === "createCategory" || preview.hidden || preview.forwards || preview.skipped > 0 || checking || consent || checkError || preview.leftOut + preview.unchecked > 0 || (preview.keep.kind !== "hidden" && !ruleOnly)) && (
        <div className="hairline-t flex flex-col gap-1.5 pt-3">
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
          {consent && (
            <div className="space-y-1.5 pt-0.5" data-testid="action-consent">
              <p className="text-xs">{t("action.consent", { provider: origin ? `${label} (${origin})` : label })}</p>
              <div className="flex gap-2">
                <Button size="xs" className="no-drag" data-testid="action-consent-continue" onClick={() => void check({ acknowledge: consent.destination })}>{t("action.consent.continue")}</Button>
                <Button size="xs" variant="secondary" className="no-drag" data-testid="action-consent-skip" onClick={() => void check({ skip: true })}>{t("action.consent.skip")}</Button>
              </div>
            </div>
          )}
          {checkError && (
            <div className="space-y-1.5 pt-0.5" data-testid="action-check-error">
              <p className="text-xs text-destructive-ink">{checkError}</p>
              <div className="flex gap-2">
                <Button size="xs" variant="secondary" className="no-drag" data-testid="action-check-retry" onClick={() => void check({})}>{t("ask.tryAgain")}</Button>
                <Button size="xs" variant="secondary" className="no-drag" onClick={() => void check({ skip: true })}>{t("action.consent.skip")}</Button>
              </div>
            </div>
          )}
          {preview.leftOut + preview.unchecked > 0 && (
            <Line testId="action-left-out">
              {preview.leftOut > 0 && <span>{t("action.leftOut", { count: preview.leftOut })}</span>}
              {preview.leftOut > 0 && preview.unchecked > 0 && <Dot />}
              {preview.unchecked > 0 && <span data-testid="action-unchecked">{t("action.unchecked", { count: preview.unchecked })}</span>}
              {preview.unchecked > 0 && !checking && <Button variant="link-secondary" size="xs" className="no-drag" data-testid="action-check-more" onClick={() => void check({})}>{t("action.checkMore")}</Button>}
              <Dot />
              <Button variant="link-secondary" size="xs" className="no-drag" data-testid="action-show-left-out" aria-expanded={leftOutShown} onClick={() => showLeftOut(!leftOutShown)}>{t(leftOutShown ? "action.leftOut.hide" : "action.leftOut.show")}</Button>
            </Line>
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
      {/* the keys, said where the eye is: ⌘↩ and Esc are the header's buttons, x a row's check */}
      {/* plan 161, pass 3: the decision, where the review ends (Split's reader; List's header is right above the rule) */}
      {reader && (
        // sticky at the pane's foot: a long rule (Details open) never scrolls the decision, nor Stop, out of reach (Codex review, pass 3, #4)
        <div className="sticky bottom-0 z-10 -mb-3 flex flex-wrap items-center gap-2 bg-background pt-1 pb-3" data-testid="action-decision">
          <ActionButtons size="default" order="apply-first" />
        </div>
      )}
      {!ruleOnly && (
        // plan 161, pass 2: the keys as keycaps on one line, the help on its own
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="action-keys">
            <span className="inline-flex items-center gap-1.5"><Shortcut keys="mod+enter" /> {waiting ? t(`action.button.${verb}`) : t(`action.apply.${verb}`, { count })}</span>
            <span className="inline-flex items-center gap-1.5"><Shortcut keys="escape" /> {t("common.cancel")}</span>
            <span className="inline-flex items-center gap-1.5"><Shortcut keys="x" /> {t("action.rule.leaveOut")}</span>
          </p>
          {reader && <p className="text-pretty" data-testid="action-help">{t("action.rule.keys")}</p>}
        </div>
      )}
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
