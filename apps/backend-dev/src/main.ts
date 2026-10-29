import { join } from "node:path";
import { adoptLegacyEnv } from "@terno/core/legacy-env";
import { startDevServer } from "./server";

adoptLegacyEnv(process.env, () => console.warn("[backend-dev] legacy environment variable detected; use TERNO_* names"));

const server = await startDevServer({
  port: Number(process.env.TERNO_DEV_PORT ?? 5174),
  dataDir: process.env.TERNO_DATA_DIR ?? join(process.cwd(), ".data"),
  token: process.env.TERNO_DEV_TOKEN ?? "dev",
  fresh: process.env.TERNO_FRESH === "1",
  threads: Number(process.env.TERNO_THREADS ?? 3000),
  accounts: Number(process.env.TERNO_ACCOUNTS ?? 4),
});
console.log("[backend-dev] listening on localhost");
const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
