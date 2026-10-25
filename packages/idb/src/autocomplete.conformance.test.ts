import "fake-indexeddb/auto";
import type { MailStore, Platform } from "@terno/store";
import { defineAutocompleteConformance, memoryFiles } from "@terno/store/conformance";
import { IdbMailStore } from "./store";

// files only give the store a snapshot base (the service writes through its own)
const platform: Pick<Platform, "uuid" | "yield" | "files"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)), files: memoryFiles() };
let n = 0;
const open = (name: string) => IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });

defineAutocompleteConformance("IdbMailStore (fake-indexeddb)", {
  open: () => open(`ac-${Date.now()}-${++n}`),
  reopen: async (store: MailStore) => {
    const name = (store as IdbMailStore).name;
    await store.close();
    return open(name);
  },
});
