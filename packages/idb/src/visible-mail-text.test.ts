import "fake-indexeddb/auto";
import { expect } from "vitest";
import { defineVisibleStore } from "../../mail/src/test/visible-store";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
// its scan and its index each read the parsed text on their own path, so both modes answer what the text can decide
for (const instantSearch of [false, true]) defineVisibleStore(`IDB (instant=${instantSearch})`, {
  cases: "store-facing",
  ...(instantSearch ? { settle: async (store) => { expect(await (store as IdbMailStore).instant!.settled()).toBe(true); }, strategy: /^instant:/ } : { strategy: /^scan$/ }),
  open: () => IdbMailStore.open({ name: `visible-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch }),
  reopen: async (store) => { const name = (store as IdbMailStore).name; await store.close(); return IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch }); },
});
