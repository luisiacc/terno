import type { ThreadDetail } from "@terno/core";
import type { Db } from "./sqlite";

interface Stamp { changes: number; data_version: number; schema_version: number }
interface Entry { stamp: Stamp; detail: ThreadDetail }
const entries = new WeakMap<Db, Entry>();
const registered = new WeakSet<Db>();
const MAX_MESSAGES = 8192;
const MAX_BYTES = 16 * 2 ** 20;

function stamp(db: Db): Stamp {
  return db.get<Stamp>("SELECT total_changes() AS changes, data_version, schema_version FROM pragma_data_version, pragma_schema_version")!;
}
function same(a: Stamp, b: Stamp): boolean {
  return a.changes === b.changes && a.data_version === b.data_version && a.schema_version === b.schema_version;
}

// Conservative admission accounting; stop before allocating a serialized image or private copy.
function fits(detail: ThreadDetail): boolean {
  if (detail.messages.length > MAX_MESSAGES || detail.messages.some((m) => !Array.isArray(m.references) || m.references.some((r) => typeof r !== "string"))) return false;
  let bytes = 0;
  function visit(value: unknown, depth: number): boolean {
    if (depth > 32) return false;
    if (typeof value === "string") bytes += value.length * 2;
    else if (value && typeof value === "object") {
      bytes += 64;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        bytes += 16;
        if (bytes > MAX_BYTES || !visit((value as Record<string, unknown>)[key], depth + 1)) return false;
      }
    }
    return bytes <= MAX_BYTES;
  }
  return visit(detail, 0);
}

function copy(detail: ThreadDetail): ThreadDetail {
  return {
    thread: { ...detail.thread, categoryIds: [...detail.thread.categoryIds] },
    messages: detail.messages.map((m) => ({
      ...m, from: { ...m.from }, replyTo: m.replyTo.map((a) => ({ ...a })),
      to: m.to.map((a) => ({ ...a })), cc: m.cc.map((a) => ({ ...a })),
      references: [...m.references], attachments: m.attachments.map((a) => ({ ...a })),
    })),
  };
}

/** One private decoded conversation per connection; every caller owns its returned containers. */
export function readThread(db: Db, id: number, load: () => ThreadDetail | null): ThreadDetail | null {
  if (!db.autocommit) {
    entries.delete(db);
    return load();
  }
  if (!registered.has(db)) {
    registered.add(db);
    db.onClose(() => entries.delete(db));
  }
  const before = stamp(db);
  const hit = entries.get(db);
  if (hit?.detail.thread.id === id && same(hit.stamp, before)) return copy(hit.detail);
  entries.delete(db);
  const detail = load();
  if (detail && fits(detail) && same(before, stamp(db))) {
    entries.set(db, { stamp: before, detail: copy(detail) });
  }
  return detail;
}
