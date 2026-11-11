import { PINS_MAX, type Pin } from "@terno/core";
import type { PinsSnapshot } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { registerUndo, snack } from "~/lib/snack";
import { listCovered } from "~/lib/page";
import { currentTargets } from "~/lib/select";
import { getApp, inPlainInbox } from "~/state/app";
import { refreshList, reloadList, useList } from "~/state/list";
import { usePins } from "~/state/pins";

/**
 * Plan 179: conversations pinned to the Inbox's top. The backend keeps them
 * (`pins.*`, the `pins` event); this keeps the renderer's set, pins and unpins
 * with an exact Undo, and moves rows into or out of the Pinned section.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The Inbox's top follows its pins: its whole loaded window is kept, in both layouts (the selection and checked rows
 * stay); its first row on screen is kept too, unless the list sits at its very top, where the section shows coming.
 */
function refreshTop(): void {
  if (!inPlainInbox(getApp())) return;
  if (listCovered()) refreshList(true);
  else void reloadList({ keepSelection: true, keepWindow: true });
}

export function applyPins(snapshot: PinsSnapshot): void {
  const before = usePins.getState();
  const ids = new Set(snapshot.pins.map((p) => p.threadId));
  if (before.loaded && ids.size === before.ids.size && [...ids].every((id) => before.ids.has(id))) {
    // the same conversations (a pin's time alone can't change): nothing to show anew; the order may have
    if (JSON.stringify(snapshot.pins) !== order.last) refreshTop();
    order.last = JSON.stringify(snapshot.pins);
    return;
  }
  order.last = JSON.stringify(snapshot.pins);
  usePins.setState({ ids, loaded: true });
  // the first snapshot at startup comes before the first list (boot waits for it): nothing to reload yet
  if (!before.loaded && useList.getState().itemsKey === "") return;
  refreshTop();
}

/** what the last snapshot said, whole (a module object: the React Compiler note) */
const order = { last: "" };

export async function loadPins(): Promise<void> {
  applyPins(await client.call("pins.list", {}));
}

/**
 * The conversations an action on pins applies to: the selection or the checked rows. A "select all N" has no ids to
 * pin (and pins are a few): the snack says to pick them, and null means nothing is done.
 */
function pinTargets(ids?: readonly number[]): number[] | null {
  if (ids) return [...ids];
  const target = currentTargets();
  if ("scope" in target) {
    snack(t("pins.noScope"));
    return null;
  }
  return target.ids;
}

/** Pins these (default: the selection); a snack with Undo, which takes away exactly what it pinned. */
export async function pinThreads(ids?: readonly number[]): Promise<boolean> {
  const pinned = usePins.getState().ids;
  // only what isn't pinned yet goes (a large selection with a few pinned in it); past the cap, said before asking
  const targets = pinTargets(ids)?.filter((id) => !pinned.has(id));
  if (!targets?.length) return false;
  if (pinned.size + targets.length > PINS_MAX) {
    snack.error(t("pins.failed"), { description: t("errors.pinsFull", { max: PINS_MAX }) });
    return false;
  }
  let added: Pin[];
  try {
    added = (await client.call("pins.add", { threadIds: targets })).added;
  } catch (error) {
    snack.error(t("pins.failed"), { description: errorText(error) });
    return false;
  }
  const undo = registerUndo(() => client.call("pins.restore", { drop: added, put: [] }).then(() => undefined));
  snack.success(t("pins.snack.pinned", { count: Math.max(1, added.length) }), { action: { label: t("common.undo"), name: t("pins.undoPin"), undo } });
  return true;
}

/** Unpins these (default: the selection); its Undo puts back exactly what it took. */
export async function unpinThreads(ids?: readonly number[]): Promise<boolean> {
  // only the pinned ones go (at most PINS_MAX, however large the selection: Codex review)
  const pinned = usePins.getState().ids;
  const targets = pinTargets(ids)?.filter((id) => pinned.has(id));
  if (!targets?.length) return false;
  let removed: Pin[];
  try {
    removed = (await client.call("pins.remove", { threadIds: targets })).removed;
  } catch (error) {
    snack.error(t("pins.unpinFailed"), { description: errorText(error) });
    return false;
  }
  if (removed.length === 0) return false;
  const undo = registerUndo(() => client.call("pins.restore", { drop: [], put: removed }).then(() => undefined));
  snack.success(t("pins.snack.unpinned", { count: removed.length }), { action: { label: t("common.undo"), name: t("pins.undoUnpin"), undo } });
  return true;
}

/** p: pins the targets unless every one already is, then unpins them. */
export function togglePin(ids?: readonly number[]): void {
  const targets = pinTargets(ids);
  if (!targets?.length) return;
  const pinned = usePins.getState().ids;
  void (targets.every((id) => pinned.has(id)) ? unpinThreads(targets) : pinThreads(targets));
}
