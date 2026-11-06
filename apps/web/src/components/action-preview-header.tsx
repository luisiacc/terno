import { savesRuleOnly } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Spinner } from "@terno/ui/components/spinner";
import { useEffect, type ReactNode } from "react";
import { providerLabel } from "~/lib/ai";
import { applyPreview, check, includeSkipped, showLeftOut, stopApplying, useActionPreview } from "~/lib/action-preview";
import { conditionText } from "~/lib/rule-text";
import { isMac } from "~/lib/select";
import { leavePreview, useActionRows } from "~/state/action-preview";
import { getApp, setApp, useApp } from "~/state/app";

const Line = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" data-testid={testId}>
    {children}
  </p>
);

const Dot = () => <span aria-hidden>·</span>;

/** Plan 143 §4: the list header's place while a sentence's preview is the list, on its content line. */
export default function ActionPreviewHeader() {
  const preview = useActionPreview((s) => s.preview);
  const future = useActionPreview((s) => s.future);
  const checking = useActionPreview((s) => s.checking);
  const consent = useActionPreview((s) => s.consent);
  const checkError = useActionPreview((s) => s.checkError);
  const applying = useActionPreview((s) => s.applying);
  const leftOutShown = useActionRows((s) => s.showLeftOut);
  const ai = useApp((s) => s.settings?.ai);
  const folderName = useApp((s) => {
    const a = useActionPreview.getState().preview?.plan.action;
    return a?.type === "moveToFolder" ? (s.folders.find((f) => f.accountId === a.accountId && f.key === a.folder)?.path.at(-1) ?? a.folder) : "";
  });
  const editAsFilter = () => {
    const p = useActionPreview.getState().preview;
    if (!p || p.plan.action.type === "createCategory") return;
    const { action } = p.plan;
    const act = action.type === "moveToCategory" ? { type: "addCategory" as const, categoryId: action.categoryId } : action.type === "moveToFolder" ? { type: "moveToFolder" as const, accountId: action.accountId, folder: action.folder } : { type: action.type };
    setApp({ dialog: "filters", filterPrefill: { name: p.plan.summary, rule: { match: "all", conditions: p.keepConditions, actions: [act] }, source: "ai" } });
  };
  const accountEmail = (id: number) => getApp().accounts.find((a) => a.id === id)?.email ?? "";

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

  if (!preview) return null;
  const { plan, count } = preview;
  const verb = plan.action.type === "createCategory" ? "moveToCategory" : plan.action.type;
  const ruleOnly = savesRuleOnly(preview);
  const title = ruleOnly ? plan.summary : t(`action.title.${verb}`, { count, category: preview.categoryName ?? "", folder: folderName });
  const waiting = preview.scanning || preview.check === "needed" || checking;
  const conditions = (future ? preview.keepConditions : plan.conditions).map((c) => conditionText(c, accountEmail));
  const label = consent ? providerLabel(consent.provider as Parameters<typeof providerLabel>[0], ai ?? undefined) : "";
  const origin = consent?.provider === "compatible" && consent.endpoint && URL.canParse(consent.endpoint) ? new URL(consent.endpoint).host : null;
  return (
    <section data-testid="action-preview" aria-label={t("action.region", { summary: plan.summary })} className="drag-region shrink-0 space-y-1 border-b border-hairline px-5 pt-3 pb-2.5">
      <div className="flex min-h-7 items-center gap-2">
        <h1 data-testid="action-title" className="min-w-0 flex-1 text-md font-semibold tracking-tight" aria-live="polite">{title}</h1>
        {applying ? (
          <Button size="sm" variant="secondary" className="no-drag" data-testid="action-stop" onClick={stopApplying}>{t("action.stop")}</Button>
        ) : (
          <Button size="sm" variant="secondary" className="no-drag" data-testid="action-cancel" onClick={leavePreview}>{t("common.cancel")}</Button>
        )}
        <Button size="sm" className="no-drag" data-testid="action-apply" disabled={waiting || applying || (count === 0 && !ruleOnly)} onClick={() => void applyPreview()}>{ruleOnly ? t("action.rule.save") : t(`action.button.${verb}`)}</Button>
      </div>
      <Line testId="action-conditions">
        <span>{t(plan.lookIn === "inbox" || plan.action.type === "archive" ? "action.in.inbox" : "action.in.everywhere")}</span>
        {conditions.map((c, i) => (
          <span key={i} className="contents"><Dot /><span>{c}</span></span>
        ))}
        {plan.action.type !== "createCategory" && (
          <>
            <Dot />
            <Button variant="link-secondary" size="xs" className="no-drag" data-testid="action-edit-filter" onClick={editAsFilter}>{t("action.editAsFilter")}</Button>
          </>
        )}
      </Line>
      {preview.scanning && <Line testId="action-finding"><Spinner className="size-3" /> {t("action.finding")}</Line>}
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
        <div className="pt-0.5">
          <label className="no-drag flex w-fit items-center gap-2 text-xs" data-testid="action-future">
            <Checkbox checked={future} disabled={preview.keep.kind !== "ok"} onCheckedChange={(on) => useActionPreview.setState({ future: on })} data-testid="action-future-box" />
            {t("action.future")}
          </label>
          {future && <p className="text-xs text-muted-foreground" data-testid="action-future-hint">{t("action.future.hint")}</p>}
          {preview.keep.kind === "disabled" && <p className="text-xs text-muted-foreground" data-testid="action-future-reason">{t(preview.keep.reason === "forwarding" ? "action.future.forwarding" : "action.future.exceptions")}</p>}
        </div>
      )}
    </section>
  );
}
