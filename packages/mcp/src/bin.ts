import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppConnection } from "./connection";
import { createMcpServer } from "./server";

// stdout carries only MCP protocol frames; logs go to stderr.
const app = new AppConnection();
const server = createMcpServer(app, process.env.UNICA_VERSION ?? "0.1.0");
await server.connect(new StdioServerTransport());
process.stdin.on("close", () => {
  app.close();
  process.exit(0);
});
