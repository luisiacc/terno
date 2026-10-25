import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { adoptLegacyEnv } from "@terno/core/legacy-env";
import { captureError } from "@terno/core/diag";
import { AppConnection } from "./connection";
import { installMcpDiag } from "./diag";
import { createMcpServer } from "./server";

// stdout carries only MCP protocol frames; diagnostics go to stderr.
async function main() {
  adoptLegacyEnv(process.env, (m) => process.stderr.write(`${m}\n`));
  const version = process.env.TERNO_VERSION ?? process.env.TERNO_BUILD_VERSION ?? "0.1.0";
  installMcpDiag(version);
  const app = new AppConnection();
  const server = createMcpServer(app, version);
  await server.connect(new StdioServerTransport());
  // On EOF, let in-flight tool calls finish and flush their responses before exiting.
  process.stdin.on("end", () => {
    void (async () => {
      await new Promise((r) => setTimeout(r, 50)); // requests read just before EOF start their backend calls
      await app.drain();
      await new Promise((r) => setTimeout(r, 50));
      app.close();
      process.exit(0);
    })();
  });
}

main().catch((error) => {
  captureError(error, { code: "mcp.start_failed", fatal: true });
  process.stderr.write(`terno-mcp: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
