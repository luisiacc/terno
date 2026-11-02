import { EventEmitter } from "node:events";
import imapkit, { type ScriptRule, type SessionInfo } from "imapkit";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function bounded<T>(work: Promise<T>, label: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function rawIdleMail(subject: string, body = "Exact foreground body") {
  return [`From: Ana <ana@example.test>`, "To: Test <test@example.test>", `Subject: ${subject}`,
    `Message-ID: <${subject}@idle.example.test>`, `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");
}

const OPENERS = new Set(["CAPABILITY", "ID", "LOGIN", "AUTHENTICATE", "STARTTLS", "NOOP", "LOGOUT", "ENABLE"]);

export async function idleFixture(idle = true, script: ScriptRule[] = []) {
  const server = imapkit({
    plugins: [...(idle ? ["IDLE"] : []), "MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"],
    storage: { INBOX: {}, "": { separator: "/", folders: {
      Sent: { "special-use": "\\Sent" }, Archive: { "special-use": "\\Archive" },
      Trash: { "special-use": "\\Trash" }, Junk: { "special-use": "\\Junk" }, Projects: {},
    } } },
  });
  const changes = new EventEmitter();
  const commands: { session: number; command: string; data: string; mailbox: string | null }[] = [];
  const completions: { session: number; command: string; status: string }[] = [];
  const idles: number[] = [];
  const byes: number[] = [];
  const arrivals: number[] = [];
  const active = new Set<number>();
  const closed = new Set<number>();
  let overflow = false;
  // a session is a mail client's once its first command opens IMAP; a stranger's knock on the port (an HTTP GET,
  // a TLS hello: another app on this machine probing new ports) is neither recorded nor counted
  const clients = new Set<number>(), strangers = new Set<number>();
  const client = (session: number, command: string) => {
    if (!clients.has(session) && !strangers.has(session)) (OPENERS.has(command.toUpperCase()) ? clients : strangers).add(session);
    return clients.has(session);
  };
  const notify = () => changes.emit("change");
  server.script.add([
    { on: "command", run: true, when(ctx) {
      if (!client(ctx.session, ctx.command ?? "")) return false;
      if (commands.length < 2000) commands.push({ session: ctx.session, command: ctx.command!, data: ctx.data, mailbox: ctx.mailbox });
      else overflow = true;
      notify();
      return false;
    } },
    { on: "input", run: true, when(ctx) {
      if (ctx.data.trim().toUpperCase() === "DONE") {
        if (commands.length < 2000) commands.push({ session: ctx.session, command: "DONE", data: ctx.data, mailbox: ctx.mailbox });
        else overflow = true;
        active.delete(ctx.session);
        notify();
      }
      return false;
    } },
    { on: "response", drop: true, when(ctx) {
      const list = /^\* BYE\b/i.test(ctx.data) ? byes : /^\* \d+ EXISTS\b/i.test(ctx.data) ? arrivals : undefined;
      if (list) {
        if (list.length < 2000) list.push(ctx.session);
        else overflow = true;
        notify();
      }
      return false;
    } },
    ...script,
  ]);
  const sessionEvent = (event: { type: string; command?: string; session: SessionInfo }) => {
    const id = event.session.session;
    if (event.type === "waiting" && event.command === "IDLE") {
      if (idles.length < 2000) idles.push(id);
      else overflow = true;
      active.add(id);
    }
    if (event.type === "close") { closed.add(id); active.delete(id); }
    notify();
  };
  const commandEvent = (event: { session: number; command: string; status: string }) => {
    if (completions.length < 2000) completions.push(event);
    else overflow = true;
    if (event.command === "IDLE") active.delete(event.session);
    notify();
  };
  server.on("session", sessionEvent);
  server.on("command", commandEvent);
  let port: number;
  try { port = await bounded(server.start(0, "127.0.0.1"), "fixture listen"); }
  catch (error) {
    try { await bounded(server.stop(), "failed fixture stop"); }
    finally { server.off("session", sessionEvent); server.off("command", commandEvent); changes.removeAllListeners(); }
    throw error;
  }

  async function wait<T>(read: () => T | undefined, label: string, ms = 5000): Promise<T> {
    let check: () => void = () => {};
    try {
      return await bounded(new Promise<T>((resolve) => {
        check = () => { const value = read(); if (value !== undefined) resolve(value); };
        changes.on("change", check);
        check();
      }), label, ms);
    } finally { changes.off("change", check); }
  }

  return { server, port, commands, completions, idles, byes, arrivals, active, closed, wait,
    get overflow() { return overflow; },
    /** sessions mail clients opened (not strangers probing the port) */
    get sessions() { return clients.size; },
    async stop() {
      try { await bounded(server.stop(), "fixture stop"); }
      finally { server.off("session", sessionEvent); server.off("command", commandEvent); changes.removeAllListeners(); }
    },
  };
}
