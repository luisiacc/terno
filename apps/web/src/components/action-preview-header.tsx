import { savesRuleOnly, type ActionPreviewInfo } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Chip } from "@terno/ui/components/chip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Spinner } from "@terno/ui/components/spinner";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useRef, type ReactNode } from "react";
import { providerLabel } from "~/lib/ai";
import { applyPreview, check, inboxOnly, includeSkipped, previewWaiting, showLeftOut, stopApplying, useActionPreview } from "~/lib/action-preview";
import { useAppearance } from "~/lib/appearance";
import { LIST_TITLE } from "~/lib/list-title";
import { PANE_TITLE, PANE_TITLE_TOP, READING_COLUMN } from "~/lib/pane-lines";
import { hasDetails, ruleDetails, ruleRow } from "~/lib/rule-words";
import { isMac } from "~/lib/select";
import { leavePreview, useActionRows } from "~/state/action-preview";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

const Line = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" data-testid={testId}>
    {children}
  </p>
);

const Dot = () => <span aria-hidden>·</span>;

const verbOf = (p: ActionPreviewInfo) => (p.plan.action.type === "createCategory" ? "moveToCategory" : p.plan.action.type);

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
  const applying = useActionPreview((s) => s.applying);
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

  // plan 161: ready, the keys are the list's (whatever the palette handed focus back to as it closed), unless you're typing
  const ready = preview !== null && !previewWaiting(preview, checking);
  const readyFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !preview || readyFor.current === preview.previewId) return;
    readyFor.current = preview.previewId;
    const at = document.activeElement;
    if (at?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [data-composer]")) return;
    document.querySelector<HTMLElement>('[data-keep-scroll="list"]')?.focus({ preventScroll: true });
  }, [ready, preview]);

  if (!preview) return null;
  const { plan, count } = preview;
  const verb = verbOf(preview);
  const ruleOnly = savesRuleOnly(preview);
  const waiting = previewWaiting(preview, checking);
  // plan 161: no count is said until it's final: "Finding… 4 so far" over the 4 rows there are, then the one number the
  // title, the button and the snack all use
  const title = ruleOnly ? plan.summary : preview.scanning ? (shown > 0 ? t("action.findingSoFar", { count: shown }) : t("action.finding")) : t(`action.title.${verb}`, { count, category: preview.categoryName ?? "", folder: folderName });
  const button = ruleOnly ? t("action.rule.save") : waiting ? t(`action.button.${verb}`) : t(`action.apply.${verb}`, { count });
  return (
    <section data-testid="action-preview" aria-label={t("action.region", { summary: plan.summary })} className="drag-region shrink-0 space-y-1 border-b border-hairline px-5 pt-3 pb-2.5">
      <div className="flex min-h-7 items-center gap-2">
        <h1 data-testid="action-title" className={cn("flex min-w-0 flex-1 items-center gap-2", LIST_TITLE.title)} aria-live="polite">
          {preview.scanning && <Spinner data-testid="action-finding" className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0">{title}</span>
        </h1>
        {applying ? (
          <Button size="sm" variant="secondary" className="no-drag" data-testid="action-stop" onClick={stopApplying}>{t("action.stop")}</Button>
        ) : (
          <Button size="sm" variant="secondary" className="no-drag" data-testid="action-cancel" onClick={leavePreview}>{t("common.cancel")}</Button>
        )}
        <Button size="sm" className="no-drag tabular" data-testid="action-apply" disabled={waiting || applying || (count === 0 && !ruleOnly)} onClick={() => void applyPreview()}>{button}</Button>
      </div>
      {/* the words typed, when the rule (which they head) isn't on screen */}
      {!ruleInReader && sentence && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="action-sentence">
          <span className="min-w-0 truncate" title={sentence}>“{sentence}”</span>
          {!list && (
            <>
              <Dot />
              <Button variant="link-secondary" size="xs" className="no-drag shrink-0" data-testid="action-show-rule" onClick={() => setApp({ selectedId: null, readerOpen: false })}>{t("action.rule.show")}</Button>
            </>
          )}
        </p>
      )}
      {list && <ActionRule variant="list" />}
    </section>
  );
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
  const leftOutShown = useActionRows((s) => s.showLeftOut);
  const ai = useApp((s) => s.settings?.ai);
  const accounts = useApp((s) => s.accounts);
  const folderName = useFolderName();
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
  const body = (
    // (the list's header is a window drag area: what's in it takes clicks)
    <div className={cn("flex flex-col gap-3", reader ? "text-sm" : "no-drag pt-1.5 text-xs")}>
      {reader ? (
        <div>
          <h2 className={cn(PANE_TITLE, "text-pretty")} data-testid="action-rule-title">{sentence ? `“${sentence}”` : plan.summary}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{ruleOnly ? plan.summary : t(`action.title.${verb}`, { count, category: preview.categoryName ?? "", folder: folderName })}</p>
        </div>
      ) : (
        sentence && <p className="text-xs text-muted-foreground" data-testid="action-rule-title">“{sentence}”</p>
      )}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("action.rule.readAs")}</h3>
        <dl data-testid="action-conditions" className={cn("mt-1.5 grid grid-cols-[minmax(5rem,max-content)_1fr] items-baseline gap-x-4", reader ? "gap-y-2" : "gap-y-1")}>
          {rows.map((r, i) => (
            <div key={i} className="contents" data-testid="action-rule-row">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1">
                <span>{r.text}</span>
                {r.terms?.map((term) => (
                  <Chip key={term} data-testid="action-rule-term" className="font-normal">{term}</Chip>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {hasDetails(conditions) && (
        <Collapsible data-testid="action-details">
          <CollapsibleTrigger className="w-auto gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&>[data-slot=collapsible-chevron]]:ms-0 [&>[data-slot=collapsible-chevron]]:size-3.5" data-testid="action-details-toggle">
            {t("action.rule.details")}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="mt-1 space-y-0.5 font-mono text-xs break-all text-muted-foreground" data-testid="action-details-text">
              {ruleDetails(conditions, accountEmail).map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      )}
      {plan.action.type !== "createCategory" && (
        <div>
          <Button variant="secondary" size="xs" className="no-drag" data-testid="action-edit-filter" onClick={editAsFilter}>{t("action.editAsFilter")}</Button>
        </div>
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
      {!ruleOnly && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="action-keys">
          <span className="inline-flex items-center gap-1.5"><Shortcut keys="mod+enter" /> {waiting ? t(`action.button.${verb}`) : t(`action.apply.${verb}`, { count })}</span>
          <span className="inline-flex items-center gap-1.5"><Shortcut keys="escape" /> {t("common.cancel")}</span>
          {reader && <span>{t("action.rule.keys")}</span>}
        </p>
      )}
    </div>
  );
  if (!reader) return body;
  return (
    <section data-testid="action-rule" aria-label={t("action.rule.region")} className="@container h-full min-h-0 bg-background">
      <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
        <div data-reader-column className={cn(READING_COLUMN, PANE_TITLE_TOP, "pb-16")}>{body}</div>
      </div>
    </section>
  );
}
