import { iterateBodyTokens } from "@terno/core";
import { BODY_PART_UNITS, bodyPartWrites } from "@terno/store";
import { openIdb, request, writeTransaction } from "./schema";
import type { R } from "./mail";

export interface IdbBodyUpgradeProgress { scanned: number; converted: number; partBytes: number; phase?: "prepared" | "committed" }

/** Dedicated native-IDB owner only: a full old body is cloned on this worker, never on the interactive host. */
export async function upgradeLegacyIdbBodies(factory: IDBFactory, name: string, yieldTo: () => Promise<void>, progress: (value: IdbBodyUpgradeProgress) => Promise<void>, check: () => void): Promise<IdbBodyUpgradeProgress> {
  const idb = await openIdb(factory, name);
  const read = <T>(store: string, key: IDBValidKey | IDBKeyRange) => request(idb.transaction(store, "readonly").objectStore(store).get(key) as IDBRequest<T | undefined>);
  const all = <T>(store: string, range: IDBKeyRange, count?: number) => request(idb.transaction(store, "readonly").objectStore(store).getAll(range, count) as IDBRequest<T[]>);
  const result: IdbBodyUpgradeProgress = { scanned: 0, converted: 0, partBytes: BODY_PART_UNITS * 2 };
  // Transactions are captured explicitly so all requests use the acknowledged transaction.
  const mutate = async (stores: string[], enqueue: (tx: IDBTransaction, track: Parameters<Parameters<typeof writeTransaction>[1]>[0]) => void) => {
    check();
    const tx = idb.transaction([...new Set([...stores, "meta"])], "readwrite", { durability: "strict" });
    await writeTransaction(tx, (track) => enqueue(tx, track));
  };
  try {
    const state = await read<{ pending?: boolean; after?: number }>("meta", "bodyPartsUpgrade");
    if (!state?.pending) return result;
    // Orphan staging is bounded by 16 keys per durable acknowledgement.
    let captureAfter = "";
    for (;;) {
      const captures = await all<R>("body_captures", IDBKeyRange.lowerBound(captureAfter, true), 16);
      if (!captures.length) break;
      for (const capture of captures) {
        check(); captureAfter = String(capture.id);
        if (await request(idb.transaction("body_heads", "readonly").objectStore("body_heads").index("capture").getKey(capture.id)) !== undefined) continue;
        for (;;) {
          const keys = await request(idb.transaction("body_parts", "readonly").objectStore("body_parts").getAllKeys(IDBKeyRange.bound([capture.id], [capture.id, 3]), 16));
          if (!keys.length) break;
          await mutate(["body_parts"], (tx, track) => { for (const key of keys) track(tx.objectStore("body_parts").delete(key)); });
          await yieldTo();
        }
        await mutate(["body_captures"], (tx, track) => track(tx.objectStore("body_captures").delete(capture.id)));
      }
    }
    let after = state.after ?? 0;
    for (;;) {
      check();
      const [body] = await all<R>("message_bodies", IDBKeyRange.lowerBound(after, true), 1);
      if (!body) break;
      const id = Number(body.message_id), message = await read<R>("messages", id);
      result.scanned++;
      if (!message || body.capture_id || Math.max(String(body.body_text ?? "").length, String(body.body_html ?? "").length) <= BODY_PART_UNITS) {
        after = id;
        if (result.scanned % 50 === 0) {
          await mutate([], (tx, track) => track(tx.objectStore("meta").put({ pending: true, after }, "bodyPartsUpgrade")));
          await progress({ ...result, phase: "committed" });
        }
        continue;
      }
      const accountId = Number(message.account_id), account = await read<R>("accounts", accountId);
      if (!account) throw new Error("Legacy body account is unavailable");
      const secretPrefix = `account:${accountId}:`;
      const secrets = await all<R>("secrets", IDBKeyRange.bound(secretPrefix, `${secretPrefix}\uffff`));
      const extraKey = account.secret_ref && !String(account.secret_ref).startsWith(secretPrefix) ? String(account.secret_ref) : null;
      const extraSecret = extraKey ? await read<R>("secrets", extraKey) : undefined;
      const locations = await all<R>("message_locations", IDBKeyRange.bound([id], [id, "\uffff"]));
      const repairs = (await all<R>("capture_repairs", IDBKeyRange.bound([accountId], [accountId, "\uffff"]))).filter((row) => row.message_id === id);
      const version = crypto.randomUUID(), text = (body.body_text ?? null) as string | null, html = (body.body_html ?? null) as string | null;
      const manifest = { id: version, account_id: accountId, message_id: id, text_parts: text === null ? null : Math.ceil(text.length / BODY_PART_UNITS), html_parts: html === null ? null : Math.ceil(html.length / BODY_PART_UNITS), token_parts: 0, ready: 0 };
      await mutate(["body_captures"], (tx, track) => track(tx.objectStore("body_captures").put(manifest, version)));
      let tokenParts = 0;
      for await (const part of bodyPartWrites(text, html, iterateBodyTokens(text ?? ""))) {
        await mutate(["body_parts"], (tx, track) => track(tx.objectStore("body_parts").put({ capture_id: version, ...part }, [version, part.field, part.ordinal])));
        if (part.field === 2) tokenParts = part.ordinal + 1;
        await yieldTo();
      }
      await progress({ ...result, phase: "prepared" });
      await mutate(["accounts", "messages", "message_bodies", "secrets", "message_locations", "capture_repairs", "body_heads", "body_captures"], (tx, track) => {
        let remaining = extraKey ? 8 : 7;
        const current: Record<string, R | R[] | undefined> = {};
        const publish = () => {
          if (--remaining) return;
          check();
          const a = current.account as R | undefined, m = current.message as R | undefined, b = current.body as R | undefined;
          const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
          if (!a || !m || !b || a.created_at !== account.created_at || a.email !== account.email || a.kind !== account.kind || a.provider_config !== account.provider_config || a.secret_ref !== account.secret_ref || m.account_id !== accountId || m.provider_msg_id !== message.provider_msg_id || m.body_state !== message.body_state || (b.body_text ?? null) !== text || (b.body_html ?? null) !== html || b.capture_id || current.head !== undefined || !same(current.secrets, secrets) || !same(current.extra, extraSecret) || !same(current.locations, locations) || !same(current.repairs, repairs)) throw new Error("Legacy body ownership changed during preparation");
          track(tx.objectStore("body_captures").put({ ...manifest, token_parts: tokenParts, ready: 1 }, version));
          track(tx.objectStore("body_heads").put({ message_id: id, capture_id: version }, id));
          track(tx.objectStore("message_bodies").put({ ...b, body_text: null, body_html: null, body_preview: text?.slice(0, 4096) ?? null, capture_id: version, body_revision: Number(b.body_revision ?? 0) + 1 }, id));
          track(tx.objectStore("meta").put({ pending: true, after: id }, "bodyPartsUpgrade"));
        };
        const get = (key: string, query: IDBRequest) => track(query, (value) => { current[key] = (key === "repairs" ? (value as R[]).filter((row) => row.message_id === id) : value) as R | R[] | undefined; publish(); });
        get("account", tx.objectStore("accounts").get(accountId)); get("message", tx.objectStore("messages").get(id)); get("body", tx.objectStore("message_bodies").get(id));
        get("secrets", tx.objectStore("secrets").getAll(IDBKeyRange.bound(secretPrefix, `${secretPrefix}\uffff`)));
        if (extraKey) get("extra", tx.objectStore("secrets").get(extraKey));
        get("locations", tx.objectStore("message_locations").getAll(IDBKeyRange.bound([id], [id, "\uffff"])));
        get("repairs", tx.objectStore("capture_repairs").getAll(IDBKeyRange.bound([accountId], [accountId, "\uffff"])));
        get("head", tx.objectStore("body_heads").get(id));
      });
      after = id; result.converted++;
      await progress({ ...result, phase: "committed" });
    }
    await mutate([], (tx, track) => track(tx.objectStore("meta").put({ pending: false, after }, "bodyPartsUpgrade")));
    return result;
  } finally { idb.close(); }
}
