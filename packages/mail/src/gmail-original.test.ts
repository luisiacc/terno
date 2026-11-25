import { describe, expect, it } from "vitest";
import { decodeGmailRaw } from "./gmail-original";
import { createGmailApiProvider } from "./gmail-api";
import { ProviderError, type ProviderContext } from "./types";

const enc = new TextEncoder();
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
/** the answer cut into chunks of `size` bytes, as a response body arrives */
const chunked = (text: string, size: number) => {
  const all = enc.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
};
const noTurn = () => Promise.resolve();

describe("decodeGmailRaw (plan 272)", () => {
  const source = enc.encode("Subject: hi\r\n\r\nHello éè world, a body of some length.\r\n");

  it("decodes the source across any chunking, padded or not", async () => {
    const padded = base64url(source);
    for (const raw of [padded, padded.replace(/=+$/, "")]) {
      const answer = `{\n  "id": "18c1",\n  "raw": "${raw}"\n}\n`;
      for (const size of [1, 3, 7, 64, 100_000]) expect(await decodeGmailRaw(chunked(answer, size), "18c1", noTurn)).toEqual(source);
    }
  });

  it("takes turns while decoding a large source", async () => {
    const big = new Uint8Array(600_000).map((_, i) => i % 251);
    let turns = 0;
    const out = await decodeGmailRaw(chunked(`{"id":"x","raw":"${base64url(big.subarray(0, 300_000))}${base64url(big.subarray(300_000))}"}`, 65536), "x", async () => { turns++; });
    expect(out).toEqual(big);
    expect(turns).toBeGreaterThan(0);
  });

  it("refuses a source over the message bound, however the answer fits its own (Codex code review #12)", async () => {
    const answer = (n: number) => chunked(`{"id":"x","raw":"${base64url(new Uint8Array(n).fill(65))}"}`, 1000);
    expect((await decodeGmailRaw(answer(3000), "x", noTurn, 3000)).length).toBe(3000);
    await expect(decodeGmailRaw(answer(3001), "x", noTurn, 3000)).rejects.toMatchObject({ code: "input-limit" });
  });

  it("refuses an answer that isn't exactly the message asked for", async () => {
    const raw = base64url(source);
    await expect(decodeGmailRaw(chunked(`{"id":"other","raw":"${raw}"}`, 50), "18c1", noTurn)).rejects.toMatchObject({ code: "malformed-resource" });
    await expect(decodeGmailRaw(chunked(`{"id":"18c1","raw":"${raw}","extra":1}`, 50), "18c1", noTurn)).rejects.toMatchObject({ code: "malformed-resource" });
    await expect(decodeGmailRaw(chunked(`{"id":"18c1","raw":"ab\\u0063d"}`, 50), "18c1", noTurn)).rejects.toMatchObject({ code: "malformed-base64" });
    await expect(decodeGmailRaw(chunked(`{"id":"18c1","raw":"abc=d"}`, 50), "18c1", noTurn)).rejects.toMatchObject({ code: "malformed-base64" });
    await expect(decodeGmailRaw(chunked(`{"id":"18c1","raw":"abcde"}`, 50), "18c1", noTurn)).rejects.toMatchObject({ code: "malformed-base64" });
    await expect(decodeGmailRaw(chunked(`{"id":"18c1"}`, 50), "18c1", noTurn)).rejects.toMatchObject({ code: "malformed-resource" });
    await expect(decodeGmailRaw(chunked(`{"id":"18c1","raw":"${raw}"`, 50), "18c1", noTurn)).rejects.toMatchObject({ code: "malformed-json" });
  });
});

describe("Gmail readOriginal (plan 272)", () => {
  const raw = enc.encode("Subject: hi\r\n\r\nbody\r\n");
  function gmail(answer: (path: string, query: string) => Response) {
    const asked: string[] = [];
    const fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname}${url.search}`);
      return answer(url.pathname, url.search);
    }) as typeof globalThis.fetch;
    const ctx = { account: { id: 1, email: "me@gmail.com" }, config: {}, fetch, store: {} } as unknown as ProviderContext;
    return { provider: createGmailApiProvider(ctx, { tokens: { get: async () => "token", invalidate() {} }, buildRaw: async () => new Uint8Array() }), asked };
  }

  it("asks for the source only and returns its bytes", async () => {
    const { provider, asked } = gmail(() => Response.json({ id: "g1", raw: base64url(raw) }));
    expect(await provider.readOriginal!({ id: 1, providerMsgId: "g1" }, new AbortController().signal)).toEqual(raw);
    expect(asked).toEqual(["/gmail/v1/users/me/messages/g1?format=raw&fields=id,raw"]);
  });

  it("is null when Gmail no longer has the message", async () => {
    const { provider } = gmail(() => Response.json({ error: { code: 404 } }, { status: 404 }));
    expect(await provider.readOriginal!({ id: 1, providerMsgId: "g1" }, new AbortController().signal)).toBeNull();
  });

  it("refuses an answer about another message", async () => {
    const { provider } = gmail(() => Response.json({ id: "g2", raw: base64url(raw) }));
    await expect(provider.readOriginal!({ id: 1, providerMsgId: "g1" }, new AbortController().signal)).rejects.toBeInstanceOf(ProviderError);
  });
});
