import "fake-indexeddb/auto";
import { exactBodyExport } from "../../store/src/conformance/s48-export";
import { nodePlatform } from "../../db/src/node-driver";
import { IdbMailStore } from "./store";
exactBodyExport(() => IdbMailStore.open({ name: `exact-export-${crypto.randomUUID()}`, factory: indexedDB, instantSearch: false, platform: nodePlatform }));
