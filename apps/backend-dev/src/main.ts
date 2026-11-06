import { join } from "node:path";
import { devAiKeys } from "@terno/core";
import { adoptLegacyEnv } from "@terno/core/legacy-env";
import { withDotEnv } from "../../../scripts/release-env.mjs";
import { startDevServer } from "./server";

adoptLegacyEnv(process.env, () => console.warn("[backend-dev] legacy environment variable detected; use TERNO_* names"));

// a developer's proof on real models: held to the spend ledger (real-ai.ts), and never set by a test or a build
const real = process.env.TERNO_AI_REAL === "1" ? await import("./real-ai") : null;
// on a copy of a real mailbox (scripts/ai-real/real-mail.real.ts): no invented mail in it, nothing fetched, no sync
const realMail = process.env.TERNO_REAL_MAIL === "1";

const server = await startDevServer({
  port: Number(process.env.TERNO_DEV_PORT ?? 5174),
  dataDir: process.env.TERNO_DATA_DIR ?? join(process.cwd(), ".data"),
  token: process.env.TERNO_DEV_TOKEN ?? "dev",
  fresh: process.env.TERNO_FRESH === "1",
  threads: Number(process.env.TERNO_THREADS ?? 3000),
  accounts: Number(process.env.TERNO_ACCOUNTS ?? 4),
  devAi: devAiKeys(withDotEnv(process.env)),
  ...(real ? { aiFactory: real.realAiFactory() } : {}),
  ...(realMail ? { seed: false, autoSync: false, iconTransport: null } : {}),
});
if (real && !realMail) await real.seedPersona(server.backend, process.env.TERNO_REPO_ROOT ?? join(process.cwd(), "../.."));
// only now: the proof types real keys into a backend that says it's held to the ledger (app-proof.mjs)
const takeBackGuard = real ? real.writeGuardMarker(Number(new URL(server.url).port)) : () => {};
console.log("[backend-dev] listening on localhost");
const stop = () => {
  takeBackGuard();
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
