import { join } from "node:path";
import { adoptLegacyEnv } from "@terno/core/legacy-env";
import { startDevServer } from "./server";

adoptLegacyEnv(process.env, () => console.warn("[backend-dev] legacy environment variable detected; use TERNO_* names"));

// a developer's proof on real models: held to the spend ledger (real-ai.ts), and never set by a test or a build
const real = process.env.TERNO_AI_REAL === "1" ? await import("./real-ai") : null;

const server = await startDevServer({
  port: Number(process.env.TERNO_DEV_PORT ?? 5174),
  dataDir: process.env.TERNO_DATA_DIR ?? join(process.cwd(), ".data"),
  token: process.env.TERNO_DEV_TOKEN ?? "dev",
  fresh: process.env.TERNO_FRESH === "1",
  threads: Number(process.env.TERNO_THREADS ?? 3000),
  accounts: Number(process.env.TERNO_ACCOUNTS ?? 4),
  ...(real ? { aiFactory: real.realAiFactory() } : {}),
});
if (real) await real.seedPersona(server.backend, process.env.TERNO_REPO_ROOT ?? join(process.cwd(), "../.."));
console.log("[backend-dev] listening on localhost");
const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
