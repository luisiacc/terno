import imapkit from "imapkit";
import { bounded } from "./imap-idle-fixture";

export async function flagsFixture(condstore: boolean) {
  const server = imapkit({
    plugins: ["SPECIAL-USE", "UIDPLUS", "ENABLE", ...(condstore ? ["CONDSTORE"] : [])],
    storage: { INBOX: {}, "": { separator: "/", folders: { Projects: {} } } },
  });
  const commands: { command: string; data: string; mailbox: string | null }[] = [];
  const responses: string[] = [];
  let overflow = false;
  server.script.add([
    { on: "command", run: true, when(ctx) {
      if (commands.length < 2000) commands.push({ command: ctx.command!, data: ctx.data, mailbox: ctx.mailbox });
      else overflow = true;
      return false;
    } },
    { on: "response", drop: true, when(ctx) {
      if (responses.length < 4000) responses.push(ctx.data);
      else overflow = true;
      return false;
    } },
  ]);
  try {
    const port = await bounded(server.start(0, "127.0.0.1"), "flag fixture listen");
    return { server, port, commands, responses, get overflow() { return overflow; },
      stop: () => bounded(server.stop(), "flag fixture stop") };
  } catch (error) { await server.stop(); throw error; }
}
