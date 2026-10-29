import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";

export function smtpCertificates() {
  const dir = mkdtempSync(join(tmpdir(), "terno-smtp-tls-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, timeout: 10_000, stdio: "pipe" });
  try {
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Terno synthetic SMTP CA");
    run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=Synthetic SMTP");
    for (const [name, ip] of [["server", "127.0.0.1"], ["wrong", "127.0.0.2"]]) {
      writeFileSync(join(dir, `${name}.ext`), `basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${ip}\n`);
      run("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`);
    }
    return {
      ca: readFileSync(join(dir, "ca.pem")), key: readFileSync(join(dir, "server.key")),
      cert: readFileSync(join(dir, "server.pem")), wrongCert: readFileSync(join(dir, "wrong.pem")),
      close: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

type Mechanism = "PLAIN" | "LOGIN";
export interface SmtpScript {
  preAuth?: Mechanism;
  postAuth?: Mechanism;
  advertise?: boolean;
  upgrade?: "refuse" | "broken";
  implicit?: boolean;
  fault?: "auth535" | "auth454" | "rcpt550" | "before354" | "afterBody";
}
export interface SmtpSession {
  events: { tls: boolean; command: string }[];
  credentials: { tls: boolean; mechanism: string; user: string; password: string }[];
  bodies: Buffer[];
  handshakes: number;
  tlsErrors: string[];
  closed: Promise<void>;
}

export async function startSmtpFixture(material: { cert: Buffer; key: Buffer }, script: (connection: number) => SmtpScript = () => ({})) {
  const sessions: SmtpSession[] = [], errors: string[] = [];
  const sockets = new Set<Socket>();
  const socketClosures: Promise<void>[] = [];
  function track(socket: Socket) {
    sockets.add(socket);
    socketClosures.push(new Promise<void>((resolve) => socket.once("close", () => { sockets.delete(socket); resolve(); })));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!(socket instanceof TLSSocket) && error.code !== "ECONNRESET") errors.push(error.message);
    });
  }
  const server = createServer((raw) => {
    track(raw);
    const options = script(sessions.length);
    const session: SmtpSession = {
      events: [], credentials: [], bodies: [], handshakes: 0, tlsErrors: [],
      closed: new Promise<void>((resolve) => raw.once("close", resolve)),
    };
    sessions.push(session);
    let socket: Socket = raw, tls = false, pending = "", bytes = 0, data = false;
    let lines: string[] = [], login: "user" | "password" | undefined, user = "", authenticated = false;
    const reply = (text: string) => socket.write(`${text}\r\n`);
    const authenticate = (mechanism: string, username: string, password: string) => {
      session.credentials.push({ tls, mechanism, user: username, password });
      if (options.fault === "auth535") reply("535 Synthetic credentials refused");
      else if (options.fault === "auth454") reply("454 Synthetic authentication unavailable");
      else if (username !== "synthetic-user" || password !== "synthetic-password") reply("535 Wrong synthetic credentials");
      else { authenticated = true; reply("235 Authenticated"); }
    };
    const upgrade = (greet: boolean) => {
      raw.removeListener("data", read);
      socket = new TLSSocket(raw, {
        isServer: true, secureContext: createSecureContext({ ...material,
          ...(options.upgrade === "broken" ? { minVersion: "TLSv1", maxVersion: "TLSv1.1" } as const : {}),
        }),
      });
      track(socket);
      socket.on("error", (error) => session.tlsErrors.push(error.message));
      socket.once("secure", () => {
        tls = true; session.handshakes++;
        session.events.push({ tls, command: "[TLS established]" });
        if (greet) reply("220 Synthetic SMTP");
      });
      socket.on("data", read);
    };
    function read(chunk: Buffer) {
      try {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw new Error("SMTP fixture byte limit exceeded");
        pending += chunk.toString("utf8");
        while (pending.includes("\r\n")) {
          const end = pending.indexOf("\r\n"), line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (data) {
            if (line !== ".") { lines.push(line.startsWith("..") ? line.slice(1) : line); continue; }
            session.bodies.push(Buffer.from(`${lines.join("\r\n")}\r\n`));
            data = false; lines = [];
            if (options.fault === "afterBody") { socket.destroy(); return; }
            reply("250 Accepted"); continue;
          }
          if (session.events.length >= 80) throw new Error("SMTP fixture command limit exceeded");
          session.events.push({ tls, command: line });
          if (login === "user") { user = Buffer.from(line, "base64").toString(); login = "password"; reply("334 UGFzc3dvcmQ6"); continue; }
          if (login === "password") { login = undefined; authenticate("LOGIN", user, Buffer.from(line, "base64").toString()); continue; }
          const command = line.split(" ")[0]!.toUpperCase();
          if (command === "EHLO") {
            const mechanism = tls ? options.postAuth ?? "LOGIN" : options.preAuth ?? "PLAIN";
            reply(`250-synthetic.test\r\n${!tls && options.advertise !== false ? "250-STARTTLS\r\n" : ""}250 AUTH ${mechanism}`);
          } else if (command === "STARTTLS") {
            if (options.upgrade === "refuse") { reply("454 Synthetic TLS unavailable"); continue; }
            if (pending) throw new Error("Unexpected pipelining across STARTTLS");
            reply("220 Upgrade now"); upgrade(false); return;
          } else if (command === "AUTH") {
            const [, mechanism, token] = line.split(" ");
            if (mechanism !== (tls ? options.postAuth ?? "LOGIN" : options.preAuth ?? "PLAIN")) { reply("504 Mechanism not advertised"); continue; }
            if (mechanism === "LOGIN") { login = "user"; reply("334 VXNlcm5hbWU6"); }
            else { const [, username, password] = Buffer.from(token ?? "", "base64").toString().split("\0"); authenticate("PLAIN", username ?? "", password ?? ""); }
          } else if (command === "MAIL") reply(authenticated ? "250 Sender accepted" : "530 Authentication required");
          else if (command === "RCPT") reply(options.fault === "rcpt550" ? "550 Synthetic recipient refused" : "250 Recipient accepted");
          else if (command === "DATA") {
            if (options.fault === "before354") { socket.destroy(); return; }
            data = true; reply("354 Send message");
          } else if (command === "QUIT") { socket.end("221 Bye\r\n"); }
          else throw new Error(`Unexpected synthetic SMTP command: ${command}`);
        }
      } catch (error) { errors.push(String(error)); socket.destroy(); }
    }
    if (options.implicit) upgrade(true);
    else { raw.on("data", read); reply("220 Synthetic SMTP"); }
  });
  async function close() {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([closed, ...socketClosures]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SMTP fixture shutdown timed out")), 4000);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return { port: (server.address() as { port: number }).port, sessions, errors, close };
  } catch (error) { await close(); throw error; }
}
