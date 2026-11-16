import type { DatedKind, DatedMute, MuteOffer } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { registerUndo, snack, type SnackAction, type Undo } from "~/lib/snack";
import { client } from "~/rpc/connection";

/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"): what Remove's snack offers, the snack a mute leaves (with
 * its own Undo), and the list of what's muted (What matters' gear and Settings). The backend keeps them (`dated.mutes`);
 * nothing here is stored or sent anywhere else.
 */

/** Undo on a mute's snack, named for what it does (as the act's own: `lib/dated`'s `said`) */
const undoing = (undo: Undo, name: string): SnackAction => ({ label: t("common.undo"), name, undo });

/** "deliveries", "entregas": a kind as the copy names it, lowercase, plural */
export const kindWords = (kind: DatedKind): string => t(`dated.mute.kinds.${kind}`);

const capital = (s: string): string => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

/** How a mute is named: a kind's words ("Deliveries"), a sender's name, else their address. */
export const muteName = (m: Pick<DatedMute, "on" | "key" | "name">): string => (m.on === "kind" ? capital(kindWords(m.key as DatedKind)) : m.name.trim() || m.key);

/** A sentence about a mute, a kind by its words ("deliveries") and a sender by name: each language says each its own way. */
export const about = (m: Pick<DatedMute, "on" | "key" | "name">, kind: "showKind" | "unmutedKind" | "hideKind" | "kindDone", sender: "showSender" | "unmutedSender" | "hideSender" | "senderDone"): string =>
  m.on === "kind" ? t(`dated.mute.${kind}`, { kind: kindWords(m.key as DatedKind) }) : t(`dated.mute.${sender}`, { sender: m.name.trim() || m.key });

/** "Don't show deliveries like this", "Don't show Parcel Co". */
export const offerLabel = (o: MuteOffer): string => (o.on === "kind" ? t("dated.mute.offerKind", { kind: kindWords(o.key) }) : t("dated.mute.offerSender", { sender: cut(o.name || o.key) }));

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

/** Mute what was offered, saying so with Undo (an Unmute). */
export async function mute(o: MuteOffer): Promise<void> {
  try {
    const { mute: m } = await client.call("dated.mute", o.on === "sender" ? { on: "sender", key: o.key, name: o.name } : { on: "kind", key: o.key });
    const said = about({ ...o, name: o.on === "sender" ? o.name : "" }, "kindDone", "senderDone");
    // muted already (another window): said the same, nothing to undo
    const undo = m ? registerUndo(() => client.call("dated.unmute", { on: m.on, key: m.key }).then(() => undefined)) : null;
    snack.success(said, undo ? { action: undoing(undo, about(m!, "showKind", "showSender")) } : {});
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
    snack.success(about(m, "unmutedKind", "unmutedSender"), undo ? { action: undoing(undo, about(m, "hideKind", "hideSender")) } : {});
    return true;
  } catch (error) {
    snack.error(error instanceof Error && error.message ? error.message : t("dated.actFailed"));
    return false;
  }
}
