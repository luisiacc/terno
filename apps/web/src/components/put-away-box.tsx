import type { PutAwayDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import type { ReactNode } from "react";
import { removeFromCategory } from "~/lib/categorize";
import { dayDate } from "~/lib/format";
import { richT } from "~/lib/i18n";
import { backToInbox, categoryName, editRule, folderName, keepSenderOut, senderOf, stillPutAway, stopRule, whyOf, type PlacementNames } from "~/lib/put-away";
import { useApp } from "~/state/app";

const strong = (s: ReactNode) => <strong className="font-medium text-foreground">{s}</strong>;

/** Where focus goes when the box leaves under it (a fix that worked): the reader's toolbar, never the document */
function keepFocus(run: () => Promise<void>): () => void {
  return () => {
    const inBox = document.activeElement?.closest("[data-testid=put-away-box]") != null;
    void run().then(() => {
      if (inBox && (document.activeElement === document.body || !document.activeElement?.isConnected)) document.querySelector<HTMLElement>("[data-reader-toolbar] button")?.focus({ preventScroll: true });
    });
  };
}

/** The names the box says, read reactively: a rename shows at once */
function useNames(): PlacementNames {
  const categories = useApp((s) => s.categories);
  const folders = useApp((s) => s.folders);
  return { categories, folders };
}

/**
 * Plan 282: why this conversation is out of the Inbox, and its one-step fixes, in a hairline box under the subject (the
 * owner's box B): who did it, what, and why, from the user's own past actions. Shown while it's put away (7 days); each
 * fix acts on the placement shown here (its `at`), never on one that replaced it.
 */
export function PutAwayBox({ threadId, placed }: { threadId: number; placed: PutAwayDetail | null | undefined }) {
  const names = useNames();
  if (!placed || !stillPutAway(placed.at)) return null;
  const d = placed.detail;
  const at = placed.at;
  let sentence: ReactNode;
  let also: string | null = null;
  const actions: { label: string; testId: string; run: () => Promise<void> }[] = [];
  if (d.by === "terno") {
    const category = categoryName(names, d.categoryId);
    const sender = senderOf(d);
    const { identity, words } = whyOf(d.reasons);
    const why = identity ? t(`putAway.why.${identity.k}`, { count: identity.count, sender, domain: identity.domain }) : words.length ? t("putAway.why.like", { reasons: words.join(" · ") }) : t("putAway.why.likeBare");
    sentence = richT("putAway.box.terno", { category, why, b: strong });
    also = identity && words.length ? words.join(" · ") : null;
    actions.push({ label: t("reader.category.notIt", { category }), testId: "put-away-not", run: () => removeFromCategory(d.categoryId, [threadId]) });
    if (d.sender) actions.push({ label: t("putAway.action.keep", { sender }), testId: "put-away-keep", run: () => keepSenderOut(threadId, at, sender, category) });
  } else {
    const values = { name: d.name, category: categoryName(names, d.categoryId), folder: folderName(names, d.folder), date: dayDate(d.createdAt), b: strong };
    sentence = !placed.ruleLive ? richT("putAway.box.changed", { name: d.name, b: strong }) : d.auto ? richT(`putAway.box.auto.${d.action}`, values) : richT(`putAway.box.rule.${d.action}`, values);
    actions.push({ label: t("putAway.action.back"), testId: "put-away-back", run: () => backToInbox([{ threadId, at }]) });
    // Terno's own rule can be stopped while it's on; the user's own is theirs to edit
    if (placed.ruleLive && d.auto && placed.ruleEnabled) actions.push({ label: t("putAway.action.stop"), testId: "put-away-stop", run: () => stopRule(threadId, at, d.name) });
    else if (placed.ruleLive && !d.auto) actions.push({ label: t("putAway.action.edit"), testId: "put-away-edit", run: () => editRule(d.filterId) });
  }
  return (
    // box B (the owner): a hairline, no fill, the card's radius; text on the page's own pairs
    <section data-testid="put-away-box" aria-label={t("putAway.box.label")} className="mt-3 mb-1 flex flex-col gap-1 rounded-[calc(var(--card-radius)+4px)] border border-border px-3.5 py-2.5 text-sm text-muted-foreground">
      <p data-testid="put-away-why">
        {sentence}
        {also && <> {t("putAway.box.also", { reasons: also })}</>}
        {placed.needsLook && <> {t("putAway.box.wrote", { name: d.fromName })}</>}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {actions.map((a) => (
          <Button key={a.testId} variant="link" data-testid={a.testId} className="h-auto p-0 text-[length:inherit] leading-[inherit] font-medium" onClick={keepFocus(a.run)}>
            {a.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
