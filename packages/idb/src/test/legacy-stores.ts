// Historical object-store names stay fixed when today's schema gains a table.
const version1 = [
  "accounts",
  "threads",
  "messages",
  "message_bodies",
  "message_refs",
  "message_locations",
  "attachments",
  "categories",
  "thread_categories",
  "filters",
  "filter_applications",
  "ops",
  "op_targets",
  "user_actions",
  "dismissed_suggestions",
  "drafts",
  "settings",
  "secrets",
  "owner",
  "owner_history",
  "cls_examples",
  "cls_decisions",
  "cat_batches",
  "cls_snapshot",
  "cat_move_threads",
  "cat_move_rows",
  "cat_move_examples",
  "cat_move_decisions",
  "search_outbox",
  "search_state",
];

export function legacyStores(version: 1 | 2 | 4 | 6 | 7 | 8 | 9 | 10 | 12 | 14 | 15 | 17 | 18 | 19): string[] {
  return [
    ...version1,
    ...(version >= 4 ? ["correspondents"] : []),
    ...(version >= 6 ? ["attachment_assets", "attachment_chunks", "attachment_bytes", "attachment_links"] : []),
    ...(version >= 7 ? ["draft_counter"] : []),
    ...(version >= 8 ? ["flag_clocks", "message_flag_intents", "flag_op_effects"] : []),
    ...(version >= 12 ? ["op_control", "op_target", "op_error", "folders", "thread_folders", "folder_rebuilds"] : []),
    ...(version >= 14 ? ["send_copies", "send_copy_bytes"] : []),
    ...(version >= 15 ? ["recipient_receipts", "recipient_receipt_parts"] : []),
    ...(version >= 18 ? ["imap_identity_holds"] : []),
  ];
}

const operationParts = ["op_control", "op_target", "op_error"];
/** Fixture reconstruction only: old schemas contain complete effective wide ops. */
export function legacyImage<T extends { name: string; keys: IDBValidKey[]; values: unknown[]; indexes?: { name: string }[] }>(
  source: T[], version: Parameters<typeof legacyStores>[0],
): T[] {
  const ops = source.find((store) => store.name === "ops");
  const baseKeys = new Set(ops?.keys ?? []);
  const overlays = new Map<IDBValidKey, Record<string, unknown>>();
  for (const name of operationParts) {
    const part = source.find((store) => store.name === name);
    if (!part) continue;
    if (part.keys.length !== part.values.length) throw new Error("Malformed fixture part pairs");
    part.keys.forEach((key, i) => {
      const value = part.values[i];
      if (!baseKeys.has(key) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fixture operation part");
      overlays.set(key, { ...overlays.get(key), ...value });
    });
  }
  const allowed = new Set(["meta", ...legacyStores(version)]);
  return source.filter((store) => allowed.has(store.name)).map((store) => ({
    ...store, ...(store.indexes && { indexes: store.indexes.filter((index) => version >= 19 || store.name !== "messages" || index.name !== "cached_provider") }),
  })).map((store) => store.name !== "ops" || version >= 12 ? store : ({
    ...store, values: store.values.map((value, i) => ({ ...(value as Record<string, unknown>), ...overlays.get(store.keys[i]!) })),
  }));
}

export async function physicalImage(db: IDBDatabase) {
  const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const names = [...db.objectStoreNames], tx = db.transaction(names);
  const complete = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  const image = await Promise.all(names.map(async (name) => {
    const store = tx.objectStore(name);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, keys, values: values as unknown[], indexes: [...store.indexNames].map((name) => {
      const index = store.index(name);
      return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
    }) };
  }));
  await complete; return image;
}

/** Physical17–19 identity fixtures use logical30 rows, before later defaulted fields. */
export function identityImage(source: Awaited<ReturnType<typeof physicalImage>>, version: 17 | 18 | 19) {
  const image = legacyImage(source, version);
  const expected = ["meta", ...legacyStores(version)].sort();
  if (image.map((store) => store.name).sort().join() !== expected.join()) throw new Error("Incomplete historical identity fixture");
  return image.map((store) => ({ ...store, values: store.values.map((value, i) => {
    if (store.name === "meta") return store.keys[i] === "logicalSchema" ? 30 : value;
    const row = { ...(value as Record<string, unknown>) };
    if (store.name === "filters") delete row.auto;
    if (store.name === "categories") delete row.show_in_inbox;
    if (store.name === "threads") delete row.tab;
    if (store.name === "messages") { delete row.category; delete row.unsubscribe; }
    return row;
  }) }));
}
