import { addressKey, dayKeyOf, dueCutoff, followupDaysSince, localDay, mostUrgent, type FollowupRow, type MessageDetail } from "@terno/core";
import type { FollowupsSnapshot } from "@terno/core";
import { t } from "@terno/i18n";
import { followupsOffered } from "~/lib/ai";
import type { LeftRows } from "~/lib/actions";
import { promiseWhen, taskSaid } from "~/lib/dated";
import { onExplicitOpen } from "~/lib/open-dwell";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, inPlainInbox, navigate, useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { inboxTop, reloadList, useList } from "~/state/list";
import { dayDate, reminderDated } from "~/lib/when";

/**
 * Plan 142: what the windows know of follow-ups (the backend's snapshot, at startup and on its `followups` event), and
 * what the UI does with them. One line of the row and the thread's, in words of the app's language.
 */
export function applyFollowups(snapshot: FollowupsSnapshot): void {
  const before = useFollowups.getState();
  const byThread = new Map<number, FollowupRow[]>();
  for (const r of snapshot.rows) byThread.set(r.threadId, [...(byThread.get(r.threadId) ?? []), r]);
  const onTop = new Set(snapshot.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId)).size;
  const late = new Set(snapshot.rows.filter(countsLate).map((r) => r.threadId));
  useFollowups.setState({ rows: snapshot.rows, byThread, late, due: late.size, onTop, loaded: true });
  const s = getApp();
  if (!before.loaded && useList.getState().itemsKey === "") return;
  // a promise's Later (plan 204, the fifth panel round) moves its place in the list, not its moment
  const key = (rows: readonly FollowupRow[]) => JSON.stringify(rows.map((r) => [r.id, r.state, r.inboxState, r.dueAt, r.deferredUntil]));
  // the Inbox's top is what's on it; the Follow-ups list is all of them
  const changed = s.followups ? key(before.rows) !== key(snapshot.rows) : inPlainInbox(s) && JSON.stringify(before.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId)) !== JSON.stringify(snapshot.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId));
  if (changed) void reloadList({ keepSelection: true });
}

export async function loadFollowups(): Promise<void> {
  applyFollowups(await client.call("followups.list", {}));
}

const on = () => followupsOffered(getApp());

export const anyFollowupOnTop = (): boolean => on() && useFollowups.getState().onTop > 0;

/**
 * Plan 280 (the second QA round): a promise of theirs that's late for certain, what's red and counted: past the day they
 * named, firm, and nothing saying it may have come. One with no day, or one a notice may have brought, stays quiet.
 */
export const owedLate = (r: FollowupRow): boolean => r.kind === "theirs" && r.state === "due" && r.firm !== false && r.dated && r.arrivedHint == null;

/**
 * What the sidebar's Follow-ups number counts, and what the list marks with the dot (plan 285): one that's due. Plan 280: a
 * tentative promise of theirs is kept quietly, in the list, never in the count that calls for attention (the second QA
 * round: nor one with no day, or one a notice may have brought: the count is the red rows, "late").
 */
export const countsLate = (r: FollowupRow): boolean => r.state === "due" && (r.kind !== "theirs" || owedLate(r));

const personOf = (row: FollowupRow): string | null => row.personName || row.personEmail?.split("@")[0] || null;

/**
 * "You told Tom you'd send the contract", "Ana hasn't replied in 5 days", and "yet" until a whole day has passed (plan 161).
 * Plan 210 (iteration 3): a promise never names its person twice ("You told Jess Okafor you'd send Jess the script" is
 * "You told Jess you'd send the script"); where the words can't lose the name ("email Jess"), they keep it and the line
 * doesn't add it ("You said you'd email Jess"). `short`: the person by their first name, as the reader's line says them.
 */
export function followupLine(row: FollowupRow, now = Date.now(), { short = false, bare = false }: { short?: boolean; bare?: boolean } = {}): string {
  const name = personOf(row);
  // the second QA round: where the row's sender already is the debtor, the line is the thing alone ("Promised to send you…")
  if (row.kind === "theirs" && bare) return t(row.firm === false ? "followup.theirsHopedBare" : "followup.theirsBare", { text: row.text });
  // plan 280: "Alex promised to send you the contract"; a tentative one, "Alex hopes to…" (no pronoun guessed; the QA
  // panel: "hoped to" read as given up)
  if (row.kind === "theirs") {
    const who = name ? (short ? name.split(/\s+/)[0] || name : name) : t("followup.someone");
    return t(row.firm === false ? "followup.theirsHoped" : "followup.theirs", { name: who, text: row.text });
  }
  if (row.kind === "awaiting") {
    const who = name ?? t("followup.someone");
    const days = followupDaysSince(row.sentAt, now);
    return days === 0 ? t("followup.awaitingYet", { name: who }) : t("followup.awaiting", { name: who, count: days });
  }
  if (!name) return t("followup.promiseNoName", { text: row.text });
  const first = name.split(/\s+/)[0] || name;
  const text = withoutPerson(row.text, [name, first]);
  return text === null ? t("followup.promiseNoName", { text: row.text }) : t("followup.promise", { name: short ? first : name, text });
}

/** After a preposition, to the person ("send the script to Jess", "enviar a Valeria el guion"): it goes with them. */
const TO_PERSON = "(?:to|with|for|a|con|para)";
/** A thing given ("send Jess the script", "mandarle a Jess los papeles"): the name before it can go. */
const THING = "(?:the|a|an|your|my|his|her|their|our|its|this|that|these|those|both|all|some|every|el|la|los|las|un|una|unos|unas|tu|tus|su|sus|mi|mis|este|esta|estos|estas|ese|esa)";

/**
 * A promise's words without its person, when the sentence stands without them; the words as they are when they don't name
 * them; null when they name them and can't lose it ("email Jess", "review Jess's deck").
 */
export function withoutPerson(text: string, names: readonly string[]): string | null {
  const shown = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const mention = (n: string) => `(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`;
  // the person themselves, never their possession ("Jess's deck" keeps her)
  const word = (n: string) => `${mention(n)}(?!['’])`;
  const named = (s: string) => shown.some((n) => new RegExp(mention(n), "iu").test(s));
  if (!named(text)) return text;
  let out = text;
  for (const n of shown) {
    out = out.replace(new RegExp(`\\s+${TO_PERSON}\\s+${word(n)}`, "giu"), "");
    out = out.replace(new RegExp(`(^|\\s)${word(n)}\\s+(?=${THING}(?![\\p{L}]))`, "giu"), "$1");
  }
  out = out.replace(/\s{2,}/g, " ").trim();
  return named(out) || out.split(" ").length < 2 ? null : out;
}

/**
 * Plan 161: when the line comes back, never a bare weekday. Pass 3: under the fact (the title), so it says what happens and
 * on what: "Comes back to your Inbox Wed, Oct 28, 9:00 AM if there's no reply", or that it's due. The fourth panel round
 * (revision 10): a promise of yours says its day as Today does ("Due Tuesday", "Was due yesterday"), never the moment it's
 * placed at (a "9:00 AM" no one said); one that named no day says none (null).
 */
export function followupWhen(row: FollowupRow, now = Date.now()): string | null {
  // (plan 210, iteration 5: a part of its day is over at that part's end)
  if (row.kind === "promise") return row.dated ? promiseWhen(row, now >= dueCutoff(dayKeyOf(row.dueAt), row.partOfDay), now) : null;
  // plan 280: the day they promised ("Due Thursday", "Was due Thursday"), never the moment it's late; undated, none
  if (row.kind === "theirs") {
    // the second QA round: a hedged one says no day (a soft "early next week" read as a weekday no one said)
    if (row.firm === false) return null;
    const day = row.dueDay ? localDay(row.dueDay) : null;
    // one with no day says when it was promised, so a late one says why
    if (!day) return t("followup.theirsNoDay", { date: dayDate(row.sentAt, now) });
    day.setHours(9, 0, 0, 0);
    return promiseWhen({ dueAt: day.getTime(), dated: true, partOfDay: row.partOfDay ?? null }, now >= dueCutoff(row.dueDay!, row.partOfDay), now);
  }
  const date = reminderDated(row.dueAt, now);
  if (row.state === "due") return t("followup.dueNow", { date });
  return t("followup.dueOnAwaiting", { date });
}

/** What a row says: its most urgent, and how many more. */
export function rowLine(rows: readonly FollowupRow[] | undefined, now = Date.now()): string | null {
  if (!rows?.length || !on()) return null;
  // (the second QA round: the row shows who owes a promise of theirs, so its line doesn't name them again)
  const line = followupLine(mostUrgent(rows)!, now, { bare: true });
  return rows.length > 1 ? `${line} +${rows.length - 1}` : line;
}

/**
 * Done, Dismiss and Later, each with Undo that puts the exact row back. A promise's snack names it as Today's do ("Done:
 * send the contract", the fourth panel round); a nudge's keeps its own words.
 */
export async function actOnFollowup(row: FollowupRow, action: "done" | "dismiss" | "later", dueAt?: number, left?: LeftRows): Promise<void> {
  const text = row.kind === "promise" ? row.text : null;
  try {
    const { undoId } = await client.call("followups.act", { id: row.id, revision: row.revision, action, ...(dueAt !== undefined ? { dueAt } : {}) });
    // plan 210 (iteration 2): What matters' rows it took out come back with its Undo
    const run = () => client.call("followups.undo", { undoId: undoId! }).then(() => undefined);
    const undo = undoId === null ? null : registerUndo(() => (left ? left.undo(run) : run()));
    // plan 280: a promise of theirs is done, or wasn’t one
    const theirs = row.kind === "theirs";
    const said = text !== null ? taskSaid(action, text) : action === "done" ? t("followup.snack.done") : action === "dismiss" ? t(theirs ? "followup.snack.notAPromise" : "followup.snack.dismissed") : t("followup.snack.later", { date: reminderDated(dueAt ?? row.dueAt) });
    snack.success(said, undo ? { action: { label: t("common.undo"), name: t("followup.undo"), undo } } : {});
  } catch (error) {
    left?.failed();
    const e = error as { message?: string };
    snack.error(e.message ?? t("followup.actFailed"));
  }
}

/** Opening ends the Inbox row, not the follow-up, once it stayed on screen. What's hidden (plan 147) isn't seen: it stays for when it shows again. */
onExplicitOpen({
  opened: (id) => (on() && useFollowups.getState().byThread.get(id)?.some((r) => r.inboxState === "onTop") ? true : null),
  settled: (id) => void client.call("followups.seen", { threadId: id }).catch(() => {}),
});

/** Plan 142 §8: off hides the row, the list and the lines at once, here and in every window; on brings them back. */
useApp.subscribe((s, prev) => {
  if (!prev.settings) return;
  const now = followupsOffered(s);
  if (followupsOffered(prev) === now) return;
  if (!now && s.followups) navigate({ view: "inbox" });
  else if (inPlainInbox(s)) void reloadList({ keepSelection: true });
});

/** The selection left a thread the Inbox's top held only because it was open: it goes to its place. */
export const leftTop = (threadId: number): boolean => inboxTop.ids.includes(threadId) && !useFollowups.getState().byThread.get(threadId)?.some((r) => r.inboxState === "onTop");

/**
 * Plan 280 (§6): a promise of theirs that may have been kept already, so no reminder is offered: the debtor wrote in this
 * conversation since they promised it ("wrote"), or a service's notice named them ("notice"). Null: neither.
 */
export function mayHaveArrived(row: FollowupRow, messages: readonly Pick<MessageDetail, "id" | "date" | "from">[]): "wrote" | "notice" | null {
  if (row.kind !== "theirs") return null;
  const debtor = row.personKey ?? (row.personEmail ? addressKey(row.personEmail) : null);
  // (the Fable review: since the promise, or since the mail that last moved it, which isn't news about it; the second QA
  // round: and for one with a day, from that day: a note before it was about something else, or the model read it)
  const day = row.dated && row.dueDay ? localDay(row.dueDay)?.getTime() ?? 0 : 0;
  const since = Math.max(row.sentAt, row.movedAt ?? 0, day);
  if (debtor && messages.some((m) => m.id !== row.messageId && m.date > since && addressKey(m.from.email) === debtor)) return "wrote";
  return row.arrivedHint != null ? "notice" : null;
}
