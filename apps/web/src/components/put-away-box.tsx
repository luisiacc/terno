import type { PutAwayDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { useRef, type ReactNode } from "react";
import { dayDate } from "~/lib/format";
import { richT } from "~/lib/i18n";
import { backToInbox, bringBackRule, categoryName, keepFocusThrough, editRule, folderName, keepSenderOut, notCategory, senderOf, stillPutAway, stopRule, whyOf, type PlacementNames } from "~/lib/put-away";
import { useApp } from "~/state/app";

const strong = (s: ReactNode) => <strong className="font-medium text-foreground">{s}</strong>;

/** The names the box says, read reactively: a rename shows at once */
function useNames(): PlacementNames {
  const categories = useApp((s) => s.categories);
  const folders = useApp((s) => s.folders);
  return { categories, folders };
}

/**
 * Plan 282: why this conversation is out of the Inbox, and its one-step fixes, in a hairline box under the subject (the
 * owner's box B): who did it, what, and why, from the user's own past actions. Shown while it's put away (7 days); each
 * fix acts on the placement shown here (its `at`), never on one that replaced it. Back to Inbox leads every box.
 */
export function PutAwayBox({ threadId, placed }: { threadId: number; placed: PutAwayDetail | null | undefined }) {
  const names = useNames();
  const box = useRef<HTMLElement>(null);
  if (!placed || !stillPutAway(placed.at)) return null;
  const d = placed.detail;
  const at = placed.at;
  /** a fix that takes away the control it was on leaves focus somewhere safe (keepFocusThrough) */
  const keepFocus = (run: () => Promise<void>) => () => (box.current?.contains(document.activeElement) ? keepFocusThrough(run, () => box.current) : void run());
  let sentence: ReactNode;
  const notes: string[] = [];
  // `hint`: what it does, said before it's pressed (the third rating: its scope came only in the snack)
  const actions: { label: string; testId: string; hint?: string; run: () => Promise<void> }[] = [{ label: t("putAway.action.back"), testId: "put-away-back", run: () => backToInbox([{ threadId, at }]) }];
  if (d.by === "terno") {
    const category = categoryName(names, d.categoryId);
    const sender = senderOf(d);
    const { identity, words } = whyOf(d.reasons);
    const why = identity ? t(`putAway.why.${identity.k}`, { count: identity.count, sender, domain: identity.domain }) : words.length ? t("putAway.why.like", { reasons: words.join(" · ") }) : t("putAway.why.likeBare");
    sentence = richT("putAway.box.terno", { category, why, b: strong });
    if (identity && words.length) notes.push(t("putAway.box.also", { reasons: words.join(" · ") }));
    actions.push({ label: t("reader.category.notIt", { category }), testId: "put-away-not", hint: t("putAway.action.notHint", { category }), run: () => notCategory(threadId, at, category) });
    // said once: afterwards the box says it's done instead of offering it again
    if (placed.senderKept) notes.push(t("putAway.box.kept", { sender }));
    else if (d.sender) actions.push({ label: t("putAway.action.keep", { sender }), testId: "put-away-keep", hint: t("putAway.action.keepHint", { sender, category }), run: () => keepSenderOut(threadId, at, sender, category) });
  } else {
    const values = { name: d.name, category: categoryName(names, d.categoryId), folder: folderName(names, d.folder), date: dayDate(d.createdAt), b: strong };
    sentence = !placed.ruleLive ? richT("putAway.box.changed", { name: d.name, b: strong }) : d.auto ? richT(`putAway.box.auto.${d.action}`, values) : richT(`putAway.box.rule.${d.action}`, values);
    if (placed.ruleLive && !placed.ruleEnabled) notes.push(t("putAway.box.ruleOff"));
    // Stop's second step (the owner): what the rule still keeps away, when that's more than this one
    if ((placed.ruleHolding ?? 0) > 1) actions.push({ label: t("putAway.action.bringBack", { count: placed.ruleHolding! }), testId: "put-away-bring-back", run: () => bringBackRule(threadId, at) });
    // Terno's own rule can be stopped while it's on; the user's own is theirs to edit
    if (placed.ruleLive && d.auto && placed.ruleEnabled) actions.push({ label: t("putAway.action.stop"), testId: "put-away-stop", run: () => stopRule(threadId, at, d.name) });
    else if (placed.ruleLive && !d.auto) actions.push({ label: t("putAway.action.edit"), testId: "put-away-edit", run: () => editRule(threadId, d.filterId) });
  }
  if (placed.needsLook) notes.push(t("putAway.box.wrote", { name: d.fromName }));
  return (
    // box B (the owner): a hairline, no fill, the card's radius; text on the page's own pairs
    <section ref={box} data-testid="put-away-box" aria-label={t("putAway.box.label")} className="mt-3 mb-1 flex flex-col gap-1 rounded-[calc(var(--card-radius)+4px)] border border-border px-3.5 py-2.5 text-sm text-muted-foreground">
      <p data-testid="put-away-why">
        {sentence}
        {notes.map((n) => (
          <span key={n}> {n}</span>
        ))}
      </p>
      {/* real buttons (the UI rating: links read as prose, and were as tall as their text): Back to Inbox leads as the primary, the rest on the secondary fill
          (an outline read as disabled in dark, the third rating) */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {actions.map((a, i) => {
          // a long name wraps inside its button rather than past the reader's edge
          const button = (
            <Button key={a.testId} variant={i === 0 ? "default" : "secondary"} size="sm" data-testid={a.testId} aria-description={a.hint} className="h-auto min-h-7 max-w-full py-1 text-left whitespace-normal" onClick={keepFocus(a.run)}>
              {a.label}
            </Button>
          );
          return a.hint ? (
            <Tooltip key={a.testId}>
              <TooltipTrigger render={button} />
              <TooltipContent className="max-w-64">{a.hint}</TooltipContent>
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
    </section>
  );
}
