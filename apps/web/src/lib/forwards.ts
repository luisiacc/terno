import { FORWARD_DELAY_MS, type ForwardInfo, type ForwardQuestion, type ForwardRuleRef, type ForwardSnapshot } from "@terno/core";
import { getLocale, onLocaleChange, t } from "@terno/i18n";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { snack, withdrawSnack } from "~/lib/snack";

/**
 * Plan 116: the forwards as the windows see them (the backend's snapshot, at
 * startup and on its `forwards` event), and what the UI does with them: one
 * notice with Cancel while some wait their 10 s, the reader's line under a
 * forwarded message, and the cap's question (Keep forwarding / Stop).
 */

interface ForwardsState {
  items: readonly ForwardInfo[];
  questions: readonly ForwardQuestion[];
  byMessage: ReadonlyMap<number, readonly ForwardInfo[]>;
}

export const useForwards = create<ForwardsState>(() => ({ items: [], questions: [], byMessage: new Map() }));

const NOTICE = "forwards-waiting";
/** the waiting ones the notice stands for (its Cancel takes exactly those) */
let noticed = "";

const who = (list: readonly { name: string; email: string }[]) => {
  const first = list[0];
  const name = first ? first.name || first.email : "";
  return list.length > 1 ? t("forward.toMany", { name, count: list.length - 1 }) : name;
};

export function applyForwards(snapshot: ForwardSnapshot): void {
  const byMessage = new Map<number, ForwardInfo[]>();
  for (const f of snapshot.items) byMessage.set(f.messageId, [...(byMessage.get(f.messageId) ?? []), f]);
  useForwards.setState({ items: snapshot.items, questions: snapshot.questions, byMessage });
  notice(snapshot.items.filter((f) => f.status === "waiting"));
}

/** One notice for what waits: "Forwarding 3 messages from Facturas to Ana · Cancel"; it goes when nothing waits. */
function notice(waiting: readonly ForwardInfo[]): void {
  const key = waiting.map((f) => f.id).join(",");
  if (key === noticed) return;
  noticed = key;
  if (!waiting.length) {
    withdrawSnack(NOTICE);
    return;
  }
  const ids = waiting.map((f) => f.id);
  const rules = new Set(waiting.map((f) => f.ruleName));
  const first = waiting[0]!;
  const message = rules.size === 1
    ? t("forward.notice", { count: waiting.length, to: who(first.to) })
    : t("forward.noticeMany", { count: waiting.length });
  const last = Math.max(...waiting.map((f) => f.dueAt));
  snack(message, {
    id: NOTICE,
    // the dock is narrow: the category on the quieter second line
    ...(rules.size === 1 && first.ruleName && { description: t("forward.noticeFrom", { rule: first.ruleName }) }),
    // until the last one goes (the backend's clock and this one agree to within a turn), never under the default
    duration: Math.max(FORWARD_DELAY_MS, last - Date.now()),
    action: { label: t("common.cancel"), name: t("forward.cancelName", { count: ids.length }), onClick: () => void cancelForwards(ids) },
  });
}

export async function cancelForwards(ids: readonly number[]): Promise<void> {
  try {
    const { cancelled } = await client.call("forwards.cancel", { ids: [...ids] });
    if (cancelled) snack.success(t("forward.cancelled", { count: cancelled }));
  } catch (error) {
    snack.error(t("forward.cancelFailed"), { description: error instanceof Error ? error.message : String(error) });
  }
}

export async function retryForward(id: number): Promise<void> {
  try {
    await client.call("forwards.retry", { id });
  } catch (error) {
    snack.error(t("forward.retryFailed"), { description: error instanceof Error ? error.message : String(error) });
  }
}

export async function answerForwards(rule: ForwardRuleRef, keep: boolean): Promise<void> {
  try {
    await client.call("forwards.answer", { rule, keep });
  } catch (error) {
    snack.error(t("forward.answerFailed"), { description: error instanceof Error ? error.message : String(error) });
  }
}

export async function loadForwards(): Promise<void> {
  applyForwards(await client.call("forwards.list", {}));
}

/** The backend writes forwards in this window's language while the setting follows the system. */
export function shareLocale(): void {
  const send = () => void client.call("app.locale", { locale: getLocale() }).catch(() => {});
  send();
  onLocaleChange(send);
}
