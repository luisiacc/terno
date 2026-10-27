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

export function legacyStores(version: 1 | 2 | 4 | 6): string[] {
  return [
    ...version1,
    ...(version >= 4 ? ["correspondents"] : []),
    ...(version >= 6 ? ["attachment_assets", "attachment_chunks", "attachment_bytes", "attachment_links"] : []),
  ];
}
