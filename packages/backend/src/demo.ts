import { generateDataset } from "@unica/mock-data";
import { listAccounts, saveFilter, seedDataset, setAccountProviderConfig, type Db } from "@unica/db";

export interface DemoOptions {
  threads?: number;
  accounts?: number;
  now?: number;
}

/** Seeds an empty database with the deterministic demo mailbox (no-op if accounts exist). */
export function seedDemo(db: Db, options: DemoOptions = {}): boolean {
  if (listAccounts(db).length > 0) return false;
  const now = options.now ?? Date.UTC(2026, 9, 22, 15, 30);
  const data = generateDataset({ threads: options.threads ?? 3000, accounts: options.accounts ?? 4, now, seed: 42, bodyScale: 2 });
  const seeded = seedDataset(db, data, { now, learningSignals: true });
  seeded.accountIds.forEach((id, i) => setAccountProviderConfig(db, id, { demo: true, senderName: data.accounts[i]!.ownerName }));
  saveFilter(db, {
    name: "Notificaciones de GitHub → Desarrollo",
    enabled: true,
    source: "manual",
    rule: {
      match: "all",
      conditions: [{ field: "from", op: "equals", value: "notifications@github.com" }],
      actions: [{ type: "addCategory", categoryId: seeded.categoryIds[4]! }],
    },
  }, now);
  return true;
}
