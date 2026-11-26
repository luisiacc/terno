import { orderReasons, type PutAwayDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import type { ReactNode } from "react";
import { removeFromCategory } from "~/lib/categorize";
import { dayDate } from "~/lib/format";
import { richT } from "~/lib/i18n";
import { backToInbox, categoryName, editRule, folderName, keepSenderOut, stillPutAway, stopRule } from "~/lib/put-away";
import { reasonText } from "~/lib/reasons";

const strong = (s: ReactNode) => <strong className="font-medium text-foreground">{s}</strong>;

/** Terno's reason as the box says it: who you keep there, else what the mail is like; the rest after it. */
function ternoWhy(d: Extract<PutAwayDetail["detail"], { by: "terno" }>): { why: string; also: string | null } {
  const { lead, rest } = orderReasons(d.reasons);
  const also = rest.length ? rest.map(reasonText).join(" · ") : null;
  if (lead && typeof lead !== "string") {
    const count = Number(lead.p?.count ?? 0);
    if (lead.k === "reason.sameSender") return { why: t("putAway.why.sameSender", { count, sender: d.fromName }), also };
    if (lead.k === "reason.sameList") return { why: t("putAway.why.sameList", { count }), also };
    if (lead.k === "reason.sameDomain") return { why: t("putAway.why.sameDomain", { count, domain: String(lead.p?.domain ?? "") }), also };
  }
  // no identity reason: what it's like, with every reason said once
  const all = [lead, ...rest].filter((r) => r !== null).map(reasonText);
  return { why: all.length ? t("putAway.why.like", { reasons: all.join(" · ") }) : t("putAway.why.likeBare"), also: null };
}

/** Where focus goes when the box leaves under it (a fix that worked): the reader's toolbar, never the document */
function keepFocus(run: () => Promise<void>): () => void {
  return () => {
    const inBox = document.activeElement?.closest("[data-testid=put-away-box]") !== null;
    void run().then(() => {
      if (inBox && (document.activeElement === document.body || !document.activeElement?.isConnected)) document.querySelector<HTMLElement>("[data-reader-toolbar] button")?.focus({ preventScroll: true });
    });
  };
}

/**
 * Plan 282: why this conversation is out of the Inbox, and its one-step fixes, in a hairline box under the subject (the
 * owner's box B): who did it, what, and why, from the user's own past actions. Shown while it's put away (7 days).
 */
export function PutAwayBox({ threadId, placed }: { threadId: number; placed: PutAwayDetail | null | undefined }) {
  if (!placed || !stillPutAway(placed.at)) return null;
  const d = placed.detail;
  let sentence: ReactNode;
  let also: string | null = null;
  const actions: { label: string; testId: string; run: () => Promise<void> }[] = [];
  if (d.by === "terno") {
    const category = categoryName(d.categoryId);
    const words = ternoWhy(d);
    sentence = richT("putAway.box.terno", { category, why: words.why, b: strong });
    also = words.also;
    actions.push({ label: t("reader.category.notIt", { category }), testId: "put-away-not", run: () => removeFromCategory(d.categoryId, [threadId]) });
    if (d.sender) actions.push({ label: t("putAway.action.keep", { sender: d.fromName || d.sender }), testId: "put-away-keep", run: () => keepSenderOut(threadId, d.fromName || d.sender, d.categoryId) });
  } else {
    const values = { name: d.name, category: categoryName(d.categoryId ?? null), folder: folderName(d.folder), date: dayDate(d.createdAt), b: strong };
    sentence = !placed.ruleLive ? richT("putAway.box.changed", { name: d.name, b: strong }) : d.auto ? richT(`putAway.box.auto.${d.action}`, values) : richT(`putAway.box.rule.${d.action}`, values);
    actions.push({ label: t("putAway.action.back"), testId: "put-away-back", run: () => backToInbox([threadId]) });
    if (placed.ruleLive) {
      if (d.auto) actions.push({ label: t("putAway.action.stop"), testId: "put-away-stop", run: () => stopRule(threadId, d.name) });
      else actions.push({ label: t("putAway.action.edit"), testId: "put-away-edit", run: async () => editRule() });
    }
  }
  return (
    // box B (the owner): a hairline, no fill, the card's radius; text on the page's own pairs
    <section data-testid="put-away-box" aria-label={t("putAway.box.label")} className="mt-3 mb-1 flex flex-col gap-1 rounded-[calc(var(--card-radius)+4px)] border border-border px-3.5 py-2.5 text-[13px] leading-[1.5] text-muted-foreground">
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
