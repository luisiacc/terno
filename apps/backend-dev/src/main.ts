import { join } from "node:path";
import { startDevServer } from "./server";

const server = await startDevServer({
  port: Number(process.env.UNICA_DEV_PORT ?? 5174),
  dataDir: process.env.UNICA_DATA_DIR ?? join(process.cwd(), ".data"),
  token: process.env.UNICA_DEV_TOKEN ?? "dev",
  fresh: process.env.UNICA_FRESH === "1",
  threads: Number(process.env.UNICA_THREADS ?? 3000),
  accounts: Number(process.env.UNICA_ACCOUNTS ?? 4),
});
console.log(`[backend-dev] listening on ${server.url} (token: ${process.env.UNICA_DEV_TOKEN ?? "dev"})`);
const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
