import { generateDataset } from "@terno/mock-data";
import type { MailStore } from "@terno/store";

export interface DemoOptions {
  threads?: number;
  accounts?: number;
  now?: number;
}

/** Seeds an empty store with the deterministic demo mailbox (no-op if accounts exist). */
export async function seedDemo(store: MailStore, options: DemoOptions = {}): Promise<boolean> {
  if ((await store.accounts.list()).length > 0) return false;
  const now = options.now ?? Date.UTC(2026, 9, 22, 15, 30);
  const data = generateDataset({ threads: options.threads ?? 3000, accounts: options.accounts ?? 4, now, seed: 42, bodyScale: 2 });
  const seeded = await store.dev.seed(data, { now, learningSignals: true });
  for (const [i, id] of seeded.accountIds.entries()) await store.accounts.setProviderConfig(id, { demo: true, senderName: data.accounts[i]!.ownerName });
  await store.filters.save(
    {
      name: "Notificaciones de GitHub → Desarrollo",
      enabled: true,
      source: "manual",
      rule: {
        match: "all",
        conditions: [{ field: "from", op: "equals", value: "notifications@github.com" }],
        actions: [{ type: "addCategory", categoryId: seeded.categoryIds[4]! }],
      },
    },
    now,
  );
  return true;
}
