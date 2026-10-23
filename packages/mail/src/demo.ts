import type { MailProvider, ProviderContext, ProviderRegistry } from "./types";

/**
 * Provider for demo/mock accounts: ops succeed after a short, realistic delay
 * and nothing leaves the machine. Used by the seeded demo and visual tests.
 */
export function createDemoProvider(_ctx: ProviderContext, latencyMs = 40): MailProvider {
  const wait = () => new Promise((r) => setTimeout(r, latencyMs));
  return {
    async verify() {},
    async sync(sink) {
      sink.setSyncState({ status: "idle", lastSyncAt: Date.now(), lastError: null });
    },
    async execute(op) {
      await wait();
      if (op.kind === "send") return { providerMsgId: `demo-sent-${op.id}` };
    },
    async close() {},
  };
}

export const demoRegistry: ProviderRegistry = {
  create: (ctx) => createDemoProvider(ctx),
  async verifyImap() {},
  async connectGmail() {
    throw new Error("Gmail is not available in demo mode");
  },
};
