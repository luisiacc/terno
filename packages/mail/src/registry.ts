import { createDemoProvider, demoRegistry } from "./demo";
import type { ProviderRegistry } from "./types";

/**
 * Production registry: real providers per account kind; accounts created by
 * the demo seed (config.demo) use the offline demo provider.
 */
export function createRegistry(): ProviderRegistry {
  return {
    create(ctx) {
      if (ctx.config.demo) return createDemoProvider(ctx);
      return createDemoProvider(ctx);
    },
    verifyImap: demoRegistry.verifyImap,
    connectGmail: demoRegistry.connectGmail,
  };
}
