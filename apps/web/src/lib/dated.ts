import { datedGroup, localDay, type DatedKind, type TodayWhy } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { usd } from "~/lib/ai";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { datedDay, reminderTime } from "~/lib/when";

/** Plan 204: a dated item as Today's row carries it, what Done and Later act on. */
export type DatedRef = NonNullable<TodayWhy["item"]>;

/** What a line says of an item: its own words, its kind and its day. */
export interface DatedFacts {
  kind: DatedKind;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  /** false: an alert that named no day, which reads as its words alone */
  dated: boolean;
  text: string;
}

const capital = (s: string): string => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

const dayOf = (o: Pick<DatedFacts, "dueDay" | "dueAt">): number => localDay(o.dueDay)?.getTime() ?? o.dueAt;

/** "Was due Tuesday · …": a Missed line, an item's or a dated promise's (its text already in its own words). */
export function wasDueLine(day: number, text: string, now = Date.now()): string {
  const d = datedDay(day, now);
  return d.near === "yesterday" ? t("today.why.wasDueYesterday", { text }) : t("today.why.wasDueOn", { day: d.text, text });
}

/**
 * Plan 204 §8: an item's line, in Today's row and the reader alike: "Due Friday · Pay the electricity bill" (Deadlines and
 * Coming up), "Tomorrow 7:40 · Flight to Madrid" (a Plan: the time only when the mail gave one), "Was due Tuesday · Renew
 * the domain" (Missed); an alert that named no day, its words alone.
 */
export function datedLine(o: DatedFacts, missed: boolean, now = Date.now()): string {
  if (!o.dated) return o.text;
  if (missed) return wasDueLine(dayOf(o), o.text, now);
  const d = datedDay(dayOf(o), now);
  if (datedGroup(o.kind) === "plans") {
    const when = d.near === "today" ? t("today.when.today") : d.near === "tomorrow" ? t("today.when.tomorrow") : capital(d.text);
    return t("today.why.plan", { when: o.timed ? `${when} ${reminderTime(o.dueAt)}` : when, text: o.text });
  }
  if (d.near === "today") return t("today.why.dueToday", { text: o.text });
  if (d.near === "tomorrow") return t("today.why.dueTomorrow", { text: o.text });
  return t("today.why.dueOn", { day: d.text, text: o.text });
}

/** Done and Later (plan 204 §5), each with Undo that puts the exact item back, as follow-ups' act. Today reloads on the backend's `todayChanged`. */
export async function actOnDated(item: Pick<DatedRef, "id" | "revision">, action: "done" | "later", until?: number): Promise<void> {
  try {
    const { undoId } = await client.call("dated.act", { id: item.id, revision: item.revision, action, ...(until !== undefined ? { until } : {}) });
    const undo = undoId === null ? null : registerUndo(() => client.call("dated.undo", { undoId }).then(() => undefined));
    snack.success(t(action === "done" ? "dated.snack.done" : "dated.snack.later"), undo ? { action: { label: t("common.undo"), name: t("dated.undo"), undo } } : {});
  } catch (error) {
    const e = error as { message?: string };
    snack.error(e.message ?? t("dated.actFailed"));
  }
}

/**
 * Plan 204 §6: the one-time check of the last 14 days, offered while the feature is on and the question unanswered, with
 * the count and the cost (none on a local model), as follow-ups' 30 days (plan 142). Today's header and Settings ask it
 * alike; `save` writes the answer the way each writes settings. Nothing old is read without a yes.
 */
export function useDatedScanOffer(offering: boolean, save: (patch: { scanAnswered: true }) => Promise<unknown>): { offer: { count: number; usd: number | null } | null; answer: (check: boolean) => Promise<void> } {
  const [offer, setOffer] = useState<{ count: number; usd: number | null } | null>(null);
  useEffect(() => {
    if (!offering) return setOffer(null);
    let current = true;
    void client.call("dated.scanOffer", {}).then((o) => current && setOffer(o), () => {});
    return () => {
      current = false;
    };
  }, [offering]);
  const answer = async (check: boolean) => {
    if (check) await client.call("dated.scan", {}).catch(() => {});
    await save({ scanAnswered: true });
  };
  return { offer, answer };
}

/** The offer's words: "Check the last 14 days too? 23 messages, about $0.02."; no cost where it's free (a model of the user's own). */
export const scanOfferText = (offer: { count: number; usd: number | null }): string => (offer.usd !== null && offer.usd > 0 ? t("today.dated.scanCost", { count: offer.count, usd: usd(offer.usd) }) : t("today.dated.scan", { count: offer.count }));
