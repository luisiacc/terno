import type { ProviderContext, ProviderRegistry } from "@terno/mail";
import { describe, expect, it } from "vitest";
import { isLoopbackHost, loopbackInsecure } from "./imap-seam";

function fake(name: string, used: string[]): ProviderRegistry {
  return {
    create: () => (used.push(`${name}:create`), {}) as never,
    verifyImap: async () => void used.push(`${name}:verify`),
    connectGmail: async () => {
      throw new Error("no");
    },
  };
}

const config = (imap: string, smtp: string) => ({ imap: { host: imap, port: 1143, secure: false, user: "u" }, smtp: { host: smtp, port: 2525, secure: false, user: "u" }, senderName: "", appendToSent: true });

describe("the smoke's plain IMAP (Codex code review #6)", () => {
  it("loopback hosts only", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", " 127.0.0.1 "]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["imap.gmail.com", "127.0.0.2", "10.0.0.1", "localhost.evil.example", "", null, undefined]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("an account on this machine's servers goes plain; any other keeps TLS, for verification and for sync", async () => {
    const used: string[] = [];
    const r = loopbackInsecure(fake("secure", used), fake("insecure", used));
    await r.verifyImap(config("127.0.0.1", "localhost"), "p");
    await r.verifyImap(config("imap.example.com", "smtp.example.com"), "p");
    // one remote server is enough to keep TLS
    await r.verifyImap(config("127.0.0.1", "smtp.example.com"), "p");
    r.create({ config: config("127.0.0.1", "127.0.0.1") } as unknown as ProviderContext);
    r.create({ config: config("imap.example.com", "127.0.0.1") } as unknown as ProviderContext);
    r.create({ config: { demo: true } } as unknown as ProviderContext);
    expect(used).toEqual(["insecure:verify", "secure:verify", "secure:verify", "insecure:create", "secure:create", "secure:create"]);
  });
});
