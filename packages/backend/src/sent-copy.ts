import { ATTACHMENT_CHUNK, base64Bytes, bytesBase64 } from "@terno/core";
import type { MailStore } from "@terno/store";
import { copyUnavailable } from "@terno/store";

export async function readCopyWire(store: MailStore, id: string, yieldTo: () => Promise<void>, active: () => void): Promise<Uint8Array> {
  active();
  const row = await store.sendCopies.get(id);
  if (!row?.ready || row.retiring || !row.size) throw copyUnavailable();
  const raw = new Uint8Array(row.size);
  for (let index = 0; index < row.chunks; index++) {
    active();
    const data = await store.sendCopies.readWire(id, index);
    if (data === null) throw copyUnavailable();
    const chunk = base64Bytes(data);
    if (chunk.length !== Math.min(ATTACHMENT_CHUNK, row.size - index * ATTACHMENT_CHUNK)) throw copyUnavailable();
    raw.set(chunk, index * ATTACHMENT_CHUNK);
    await yieldTo();
  }
  active();
  active();
  return raw;
}

export async function prepareCopyWire(store: MailStore, id: string, raw: Uint8Array, yieldTo: () => Promise<void>, active: () => void): Promise<Uint8Array> {
  active();
  const row = await store.sendCopies.get(id);
  if (!row || row.retiring || row.submission !== "pending") throw copyUnavailable();
  if (row.ready) return readCopyWire(store, id, yieldTo, active);
  while (await store.sendCopies.resetWireSlice(id)) { await yieldTo(); active(); }
  active();
  await store.sendCopies.startWire(id, raw.byteLength);
  for (let offset = 0, index = 0; offset < raw.byteLength; offset += ATTACHMENT_CHUNK, index++) {
    active();
    await store.sendCopies.appendWire(id, index, bytesBase64(raw.subarray(offset, offset + ATTACHMENT_CHUNK)));
    await yieldTo();
  }
  active();
  await store.sendCopies.sealWire(id);
  active();
  return raw;
}
