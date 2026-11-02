import { BodyProtocol, BodyEpochChanged, type BodyTicket } from "@terno/store";
import { iterateBodyTokens, type TextOp } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { BODY_PART_UNITS, bodyPartCount, bodyPreview, validateBodyInput, assembleBody, bodyPartWrites, bodyTestKey, matchBodyParts, prepareBodyTokens, prepareBodySnippet, browserBodyPreparationFactory, type BodyPartSource, type IncomingMessage } from "@terno/store";
import type { Db } from "./sqlite";

const staging = new WeakMap<Db, Map<string, () => void>>();
const retiredObservers = new WeakMap<Db, () => void>();
const protocols = new WeakMap<Db, BodyProtocol>();
export function sqlBodyProtocol(db: Db): BodyProtocol {
  let protocol = protocols.get(db);
  if (!protocol) {
    protocol = new BodyProtocol(() => db.get<{ epoch: string }>("SELECT epoch FROM body_protocol WHERE id=1")!.epoch, (id) => {
      if (db.isOpen && db.get("SELECT 1 FROM body_captures WHERE id=? AND owned=0", id)) retiredObservers.get(db)?.();
    });
    protocols.set(db, protocol);
  }
  return protocol;
}
export function observeBodyRetirement(db: Db, observer: () => void): void { retiredObservers.set(db, observer); }
export function retainBody(db: Db, id: string): ReturnType<BodyProtocol["retain"]> { return sqlBodyProtocol(db).retain(id); }
export function sqlBodyParts(db: Db, capture: string, field: number, yieldTo: () => Promise<void>): BodyPartSource {
  const row = db.get<{ text_parts: number | null; html_parts: number | null; token_parts: number; ready: number }>("SELECT text_parts,html_parts,token_parts,ready FROM body_captures WHERE id=?", capture);
  if (!row?.ready) throw new Error("Body source changed before it was read");
  const expected = field === 0 ? row.text_parts : field === 1 ? row.html_parts : row.token_parts;
  const release = retainBody(db, capture);
  return { close: release, async read(after) {
    if (expected === null || after + 1 >= expected) return null;
    await yieldTo();
    const part = db.get<{ ordinal: number; value: Uint8Array }>("SELECT ordinal,value FROM body_parts WHERE capture_id=? AND field=? AND ordinal=?", capture, field, after + 1);
    if (!part) throw new Error("Incomplete body parts");
    return part;
  } };
}

/** Staged parts have no message identity until the normal fenced publication transaction. */
export async function stageBody<T extends Pick<IncomingMessage, "accountId" | "bodyText" | "bodyHtml" | "snippet" | "preparedBodyTokens" | "bodyParts">>(db: Db, message: T, yieldTo: () => Promise<void>, check?: () => void, isolated = false): Promise<T & Pick<IncomingMessage, "bodyCapture">> {
  validateBodyInput(message);
  if (!message.bodyParts && Math.max(message.bodyText?.length ?? 0, message.bodyHtml?.length ?? 0) <= BODY_PART_UNITS) return message;
  const id = db.uuid(), counts: (number | null)[] = [];
  check?.();
  let live = staging.get(db); if (!live) staging.set(db, live = new Map());
  db.tx(() => { check?.(); return db.run("INSERT INTO body_captures(id,account_id,text_parts,html_parts,token_parts) VALUES(?,?,NULL,NULL,0)", id, message.accountId); });
  live.set(id, retainBody(db, id));
  try {
    let tokenCount = 0; const acknowledged = [0, 0, 0];
    for await (const part of bodyPartWrites(message.bodyText, message.bodyHtml, message.preparedBodyTokens ?? (!isolated && (message.bodyParts?.text || (message.bodyText && message.bodyText.length > BODY_PART_UNITS)) ? prepareBodyTokens(message.bodyParts?.text ?? message.bodyText!, yieldTo, db.driver.bodyPreparation ?? browserBodyPreparationFactory, check) : iterateBodyTokens(message.bodyText ?? "")), message.bodyParts)) {
      check?.();
      db.tx(() => { check?.(); return db.run("INSERT INTO body_parts(capture_id,field,ordinal,value) VALUES(?,?,?,?)", id, part.field, part.ordinal, part.value); });
      if (part.ordinal !== acknowledged[part.field]!) throw new Error("Body acknowledgement is not contiguous");
      acknowledged[part.field]!++;
      if (part.field === 2) tokenCount = part.ordinal + 1;
      await yieldTo();
    }
    counts.push(bodyPartCount(message.bodyText, message.bodyParts?.text), bodyPartCount(message.bodyHtml, message.bodyParts?.html));
    if (acknowledged[0] !== (counts[0] ?? 0) || acknowledged[1] !== (counts[1] ?? 0)) throw new Error("Body acknowledgements are incomplete");
    check?.();
    db.tx(() => { check?.(); return db.run("UPDATE body_captures SET text_parts=?,html_parts=?,token_parts=?,ready=1 WHERE id=?", counts[0]!, counts[1]!, tokenCount, id); });
    return { ...message, bodyText: null, bodyHtml: null, bodyParts: undefined, preparedBodyTokens: undefined, bodyCapture: { id, preview: bodyPreview(message.bodyText, message.bodyParts), snippet: await prepareBodySnippet(message.snippet || message.bodyText, yieldTo, message.snippet ? undefined : message.bodyParts?.text), tail: "" } };
  } catch (error) { await finishBodyStage(db, id, yieldTo); throw error; }
}

/** Published/unknown-ACK captures are protected by the durable message pointer. */
export async function discardBody(db: Db, id: string, yieldTo: () => Promise<void>): Promise<void> {
  while (db.isOpen) {
    const ticket = sqlBodyProtocol(db).ticket();
    const done = db.tx(() => {
      sqlBodyProtocol(db).validate(ticket);
      if (sqlBodyProtocol(db).held(id) || db.get("SELECT 1 FROM body_heads WHERE capture_id=?", id)) return true;
      const rows = db.all<{ field: number; ordinal: number }>("SELECT field,ordinal FROM body_parts WHERE capture_id=? ORDER BY field,ordinal LIMIT 16", id);
      for (const row of rows) db.run("DELETE FROM body_parts WHERE capture_id=? AND field=? AND ordinal=?", id, row.field, row.ordinal);
      if (!rows.length) { db.run("DELETE FROM body_captures WHERE id=?", id); return true; }
      return false;
    });
    if (done) return;
    await yieldTo();
  }
}

/** Snapshot every representation and acquire its ownership before any selected reader can yield. */
export async function withBodySelection<T, R>(db: Db, select: () => { value: T; ids: readonly number[] }, read: (value: T, references: ReadonlyMap<number, import("@terno/core").BodyReadReference>) => Promise<R>): Promise<R> {
  const releases: (() => void)[] = [], references = new Map<number, import("@terno/core").BodyReadReference>();
  const errors: unknown[] = [];
  let result!: R;
  try {
    const value = db.tx(() => {
      const selected = select();
      for (const id of selected.ids) {
        if (references.has(id)) continue;
        const reference = bodyReadReference(db, id);
        if (reference) { releases.push(retainBody(db, reference.version)); references.set(id, reference); }
      }
      return selected.value;
    });
    result = await read(value, references);
  } catch (error) { errors.push(error); }
  finally { for (const release of releases) { try { await release(); } catch (error) { errors.push(error); } } }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Body selection failed");
  return result;
}

export async function hydrateBodyReference(db: Db, reference: import("@terno/core").BodyReadReference, yieldTo: () => Promise<void>): Promise<{ bodyText: string | null; bodyHtml: string | null }> {
  return { bodyText: reference.textParts === null ? null : await assembleBody(sqlBodyParts(db, reference.version, 0, yieldTo)), bodyHtml: reference.htmlParts === null ? null : await assembleBody(sqlBodyParts(db, reference.version, 1, yieldTo)) };
}

export async function hydrateBody(db: Db, messageId: number, yieldTo: () => Promise<void>): Promise<{ bodyText: string | null; bodyHtml: string | null } | null> {
  return withBodySelection(db, () => ({ value: null, ids: [messageId] }), async (_, references) => {
    const reference = references.get(messageId);
    return reference ? hydrateBodyReference(db, reference, yieldTo) : null;
  });
}

export type PreparedBodyMatches = Map<string, Map<string, boolean>>;
const preparedTickets = new WeakMap<PreparedBodyMatches, { ticket: BodyTicket; published: boolean }>();
const preparedRevisions = new WeakMap<PreparedBodyMatches, { epoch: string; seq: number }>();
const bodyRevision = (db: Db) => db.get<{ epoch: string; seq: number }>("SELECT epoch,seq FROM search_state WHERE id=1")!;
function checkBodyRevision(db: Db, matches: PreparedBodyMatches): void {
  const authority = preparedTickets.get(matches);
  if (authority) {
    try { sqlBodyProtocol(db).validate(authority.ticket); } catch (error) {
      if (error instanceof BodyEpochChanged && authority.published) throw new RpcError("STALE", L("errors.mail.processingBusy"), { reason: "revision" });
      throw error;
    }
  }
  const expected = preparedRevisions.get(matches);
  if (!expected) return;
  const current = bodyRevision(db);
  if (current.epoch !== expected.epoch || current.seq !== expected.seq) throw new RpcError("STALE", L("errors.mail.processingBusy"), { reason: "revision" });
}

export async function prepareBodyMatches(db: Db, tests: readonly { op: TextOp; value: string; prefix?: boolean }[], yieldTo: () => Promise<void>, extra: readonly string[] = [], published: boolean | "selected" = true, cache: PreparedBodyMatches = new Map(), check?: () => void): Promise<PreparedBodyMatches> {
  const prepared: PreparedBodyMatches = new Map();
  preparedTickets.set(prepared, { ticket: sqlBodyProtocol(db).ticket(check), published: published !== false });
  if (!tests.length) return prepared;
  if (published) preparedRevisions.set(prepared, bodyRevision(db));
  const yieldCurrent = async () => { await yieldTo(); checkBodyRevision(db, prepared); };
  let after = "";
  while (published === true) {
    const rows = db.all<{ id: string }>("SELECT DISTINCT c.id FROM body_captures c JOIN body_heads b ON b.capture_id=c.id WHERE c.id>? AND c.ready=1 ORDER BY c.id LIMIT 32", after);
    if (!rows.length) break;
    for (const row of rows) { prepared.set(row.id, cache.get(row.id) ?? new Map()); after = row.id; }
    await yieldCurrent();
  }
  for (const id of extra) prepared.set(id, cache.get(id) ?? new Map());
  for (const [id, results] of prepared) cache.set(id, results);
  for (const [id, results] of prepared) for (const test of tests) {
    const key = bodyTestKey(test.op, test.value, test.prefix);
    if (!results.has(key)) results.set(key, await matchBodyParts(sqlBodyParts(db, id, 2, yieldCurrent), test.op, test.value, test.prefix));
  }
  checkBodyRevision(db, prepared);
  return prepared;
}

const active = new WeakMap<Db, PreparedBodyMatches>();
export function withBodyMatches<T>(db: Db, matches: PreparedBodyMatches, work: () => T): T {
  return db.tx(() => {
  checkBodyRevision(db, matches);
  const prior = active.get(db); active.set(db, matches);
  try { return work(); } finally { if (prior) active.set(db, prior); else active.delete(db); }
  });
}
export function registerBodyMatches(db: Db): void {
  db.function("terno_part_match", {}, (capture, op, value, prefix) => {
    const result = active.get(db)?.get(String(capture))?.get(bodyTestKey(op as TextOp, String(value), prefix === 1));
    if (result === undefined) throw new Error("Body match was not prepared at this content revision");
    return result ? 1 : 0;
  });
}

export async function cleanupBodies(db: Db, yieldTo: () => Promise<void>): Promise<void> {
  if (!db.isOpen) return;
  let after = "";
  const through = db.get<{ id: string }>("SELECT id FROM body_captures ORDER BY id DESC LIMIT 1")?.id;
  if (!through) return;
  while (db.isOpen) {
    const rows = db.all<{ id: string }>("SELECT c.id FROM body_captures c WHERE c.owned=0 AND c.id>? AND c.id<=? AND NOT EXISTS (SELECT 1 FROM body_heads b WHERE b.capture_id=c.id) ORDER BY c.id LIMIT 16", after, through);
    if (!rows.length) return;
    for (const row of rows) { after = row.id; await discardBody(db, row.id, yieldTo); }
    await yieldTo();
  }
}

export async function finishBodyStage(db: Db, id: string, yieldTo: () => Promise<void>): Promise<void> {
  staging.get(db)?.get(id)?.();
  staging.get(db)?.delete(id);
  await discardBody(db, id, yieldTo);
  await cleanupBodies(db, yieldTo);
}

export function bodyReadReference(db: Db, messageId: number): import("@terno/core").BodyReadReference | null {
  const row = db.get<{ capture_id: string; text_parts: number | null; html_parts: number | null }>("SELECT b.capture_id,c.text_parts,c.html_parts FROM body_heads b JOIN body_captures c ON c.id=b.capture_id WHERE b.message_id=? AND c.ready=1", messageId);
  return row ? { version: row.capture_id, textParts: row.text_parts, htmlParts: row.html_parts } : null;
}
