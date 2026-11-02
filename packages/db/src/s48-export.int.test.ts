import { exactBodyExport } from "../../store/src/conformance/s48-export";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
exactBodyExport(async () => new SqlMailStore(openDatabase(":memory:"), { platform: nodePlatform, instantSearch: false }));
