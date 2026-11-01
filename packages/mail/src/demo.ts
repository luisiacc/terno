import { demoFolderChange } from "./folder-changes";
import type { MailProvider, ProviderContext, ProviderRegistry } from "./types";

/**
 * Provider for demo/mock accounts: ops succeed after a short, realistic delay
 * and nothing leaves the machine. Used by the seeded demo and visual tests.
 */
export function createDemoProvider(ctx: ProviderContext, latencyMs = 40): MailProvider {
  const wait = () => new Promise((r) => setTimeout(r, latencyMs));
  // plan 107: folders change in the list the backend keeps (Gmail-like accounts by label id, the rest by path)
  const gmail = ctx.account.kind === "gmail";
  return {
    async verify() {},
    async sync(sink) {
      sink.setSyncState({ status: "idle", lastSyncAt: Date.now(), lastError: null });
    },
    async execute(op) {
      await wait();
      if (op.kind === "send") return { providerMsgId: `demo-sent-${op.id}` };
    },
    async createFolder({ parent, name, folders }) {
      await wait();
      const r = demoFolderChange(folders, gmail, { create: { parent, name } });
      return { folders: r.folders, key: r.key! };
    },
    async renameFolder({ key, name, folders }) {
      await wait();
      const r = demoFolderChange(folders, gmail, { rename: { key, name } });
      return { folders: r.folders, renamed: r.renamed! };
    },
    async deleteFolder({ key, folders }) {
      await wait();
      const r = demoFolderChange(folders, gmail, { delete: { key } });
      return { folders: r.folders, deleted: r.deleted! };
    },
    async close() {},
  };
}

export const demoRegistry: ProviderRegistry = {
  kind: "demo",
  create: (ctx) => createDemoProvider(ctx),
  async verifyImap() {},
  async connectGmail() {
    throw new Error("Gmail is not available in demo mode");
  },
};
