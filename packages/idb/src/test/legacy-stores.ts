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

export function legacyStores(version: 1 | 2 | 4 | 6 | 7 | 8 | 9 | 10): string[] {
  return [
    ...version1,
    ...(version >= 4 ? ["correspondents"] : []),
    ...(version >= 6 ? ["attachment_assets", "attachment_chunks", "attachment_bytes", "attachment_links"] : []),
    ...(version >= 7 ? ["draft_counter"] : []),
    ...(version >= 8 ? ["flag_clocks", "message_flag_intents", "flag_op_effects"] : []),
  ];
}

const operationParts = ["op_control", "op_target", "op_error"];
/** Fixture reconstruction only: old schemas contain complete effective wide ops. */
export function legacyImage<T extends { name: string; keys: IDBValidKey[]; values: unknown[] }>(
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
  return source.filter((store) => allowed.has(store.name)).map((store) => store.name !== "ops" ? store : ({
    ...store, values: store.values.map((value, i) => ({ ...(value as Record<string, unknown>), ...overlays.get(store.keys[i]!) })),
  }));
}
