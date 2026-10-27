import "fake-indexeddb/auto";
import { defineBodyCaptureConformance } from "../../store/src/conformance/body-capture";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
for (const instantSearch of [false, true]) defineBodyCaptureConformance(`IDB (instant=${instantSearch})`, {
  open: () => IdbMailStore.open({ name: `body-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch }),
  reopen: async (store) => { const name = (store as IdbMailStore).name; await store.close(); return IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch }); },
});
