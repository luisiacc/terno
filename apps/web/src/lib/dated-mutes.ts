import { pairOf, WHOLE_MUTE_KINDS, type DatedKind, type DatedMute, type MuteOffer } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { registerUndo, snack, type SnackAction, type Undo } from "~/lib/snack";
import { client } from "~/rpc/connection";

/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"): what Remove's snack offers, the snack a mute leaves (with
 * its own Undo), and the list of what's muted (What matters' gear and Settings). The backend keeps them (`dated.mutes`);
 * nothing here is stored or sent anywhere else. Iteration 5: the snack offers that kind from that sender ("Don't show
 * deliveries from Parcelo"), or an automated sender alone; a whole kind is hidden from Settings only.
 */

type Muting = Pick<DatedMute, "on" | "key" | "name">;

/** Undo on a mute's snack, named for what it does (as the act's own: `lib/dated`'s `said`) */
const undoing = (undo: Undo, name: string): SnackAction => ({ label: t("common.undo"), name, undo });

/** "deliveries", "entregas": a kind as the copy names it, lowercase, plural */
export const kindWords = (kind: DatedKind): string => t(`dated.mute.kinds.${kind}`);

const capital = (s: string): string => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

/** A pair's kind and its sender as said: by name, else their address. */
const pairWords = (m: Muting): { kind: DatedKind; sender: string; address: string } => {
  const p = pairOf(m.key);
  return { kind: p?.kind ?? "pay", sender: m.name.trim() || (p?.sender ?? m.key), address: p?.sender ?? m.key };
};

/** How a mute is named: a kind's words ("Deliveries"), a sender's name, else their address, a pair both ("Deliveries from Parcelo"). */
export const muteName = (m: Muting): string => {
  if (m.on === "kind") return capital(kindWords(m.key as DatedKind));
  if (m.on === "sender") return m.name.trim() || m.key;
  const p = pairWords(m);
  return t("dated.mute.pairName", { kind: capital(kindWords(p.kind)), sender: p.sender });
};

/** A mute's sender's address, when the list shows it beside a name (never twice). */
export const muteAddress = (m: Muting): string | null => {
  if (m.on === "kind") return null;
  const address = m.on === "pair" ? pairWords(m).address : m.key;
  return m.name.trim() && m.name.trim() !== address ? address : null;
};

/**
 * A sentence about a mute, a kind by its words ("deliveries"), a sender by name, a pair both: each language says each
 * its own way (`dated.mute.showPair`, `pairDone`, …).
 */
export const about = (m: Muting, act: "show" | "unmuted" | "hide" | "done"): string => {
  if (m.on === "kind") return t(act === "done" ? "dated.mute.kindDone" : `dated.mute.${act}Kind`, { kind: kindWords(m.key as DatedKind) });
  if (m.on === "sender") return t(act === "done" ? "dated.mute.senderDone" : `dated.mute.${act}Sender`, { sender: m.name.trim() || m.key });
  const p = pairWords(m);
  return t(act === "done" ? "dated.mute.pairDone" : `dated.mute.${act}Pair`, { kind: kindWords(p.kind), sender: p.sender });
};

/** "Don't show deliveries from Parcelo", "Don't show anything from Parcelo". */
export const offerLabel = (o: MuteOffer): string =>
  o.on === "pair" ? t("dated.mute.offerPair", { kind: kindWords(o.kind), sender: cut(o.name || pairWords({ ...o }).address) }) : t("dated.mute.offerSender", { sender: cut(o.name || o.key) });

/** The kinds Settings can still hide whole (iteration 5: never offered by Remove), in the catalog's order. */
export const wholeKindsLeft = (mutes: readonly Muting[] | null): DatedKind[] => {
  const hidden = new Set((mutes ?? []).filter((m) => m.on === "kind").map((m) => m.key));
  return WHOLE_MUTE_KINDS.filter((k) => !hidden.has(k));
};

/** a name in the snack's one line, at most this long: its message and Undo keep their room */
const OFFER_NAME_MAX = 24;
const cut = (name: string): string => (name.length <= OFFER_NAME_MAX ? name : `${name.slice(0, OFFER_NAME_MAX - 1).trimEnd()}…`);

/** Remove's snack's quiet second button: what to mute, the first time (null: nothing to offer, or the offer couldn't be read). */
export async function muteOfferAction(id: number): Promise<SnackAction | undefined> {
  try {
    const { offer } = await client.call("dated.muteOffer", { id });
    return offer ? { label: offerLabel(offer), onClick: () => void mute(offer) } : undefined;
  } catch {
    // an offer is never worth an error: the Remove itself went through
    return undefined;
  }
}

/** Mute what was offered (or a whole kind, from Settings), saying so with Undo (an Unmute). */
export async function mute(o: MuteOffer | { on: "kind"; key: DatedKind }): Promise<void> {
  try {
    const { mute: m } = await client.call("dated.mute", o.on === "kind" ? { on: "kind", key: o.key } : { on: o.on, key: o.key, name: o.name });
    const said = about({ on: o.on, key: o.key, name: o.on === "kind" ? "" : o.name }, "done");
    // muted already (another window): said the same, nothing to undo
    const undo = m ? registerUndo(() => client.call("dated.unmute", { on: m.on, key: m.key }).then(() => undefined)) : null;
    snack.success(said, undo ? { action: undoing(undo, about(m!, "show")) } : {});
  } catch (error) {
    snack.error(error instanceof Error && error.message ? error.message : t("dated.mute.failed"));
  }
}

/** What's muted, newest first, read again whenever What matters changes (a mute or an Unmute anywhere says so). */
export function useDatedMutes(): [DatedMute[] | null, (fn: (held: DatedMute[] | null) => DatedMute[] | null) => void] {
  const [mutes, setMutes] = useState<DatedMute[] | null>(null);
  useEffect(() => {
    let current = true;
    const read = () => void client.call("dated.mutes", {}).then((r) => current && setMutes(r.mutes), () => {});
    read();
    const off = client.on("todayChanged", read);
    return () => {
      current = false;
      off();
    };
  }, []);
  return [mutes, setMutes];
}

/** Unmute, with Undo that hides it again where it was in the list. False: it failed (said in the snack). */
export async function unmute(m: DatedMute): Promise<boolean> {
  try {
    const { mute: removed } = await client.call("dated.unmute", { on: m.on, key: m.key });
    const undo = removed ? registerUndo(() => client.call("dated.mute", { on: removed.on, key: removed.key, name: removed.name, at: removed.at }).then(() => undefined)) : null;
    snack.success(about(m, "unmuted"), undo ? { action: undoing(undo, about(m, "hide")) } : {});
    return true;
  } catch (error) {
    snack.error(error instanceof Error && error.message ? error.message : t("dated.actFailed"));
    return false;
  }
}
