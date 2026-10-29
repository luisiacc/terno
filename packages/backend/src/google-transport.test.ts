import { afterEach, expect, it, vi } from "vitest";
import { ProviderCooldown, ProviderCooldownError } from "./provider-cooldown";
import { createNetworkPolicy } from "./net-policy";

const gates: ProviderCooldown[] = [];
afterEach(async () => { for (const gate of gates.splice(0)) await gate.close(); });
async function policy() {
  let raw: string | null = null;
  const gate = await ProviderCooldown.open({ read: async () => raw, update: async (fn) => { const result = fn(raw); raw = result.encoded; return result.result; } }, { wallNow: () => 1000, elapsedNow: () => 10, random: () => 0.5 });
  gates.push(gate);
  return gate.requestsFor("a".repeat(64));
}
const descriptor = { request: { endpoint: "gmail-api", purpose: "mail" } } as const;

it("freezes a managed Google Request before awaiting admission and refuses redirects", async () => {
  const sent: Request[] = [];
  const net = createNetworkPolicy({ localMode: () => true, fetch: async (input) => { sent.push(input as Request); return new Response("{}"); } });
  const headers = new Headers({ authorization: "Bearer synthetic-original" });
  const body = new URLSearchParams({ value: "original" });
  const init = { method: "POST", headers, body, redirect: "follow" as const };
  const result = net.fetchGoogle(await policy(), descriptor)("https://gmail.googleapis.com/test", init);
  headers.set("authorization", "Bearer synthetic-mutated"); body.set("value", "mutated");
  init.method = "DELETE";
  const response = await result;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.method).toBe("POST");
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer synthetic-original");
  expect(await sent[0]!.text()).toBe("value=original");
  expect(sent[0]!.redirect).toBe("error");
  expect(await response.text()).toBe("{}");
  expect(net.googlePending()).toBe(0);
});

it("holds one shared bounded physical pool through body EOF; cancel is not completion", async () => {
  const transport = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() {} })));
  const net = createNetworkPolicy({ localMode: () => true, fetch: transport });
  const fetchA = net.fetchGoogle(await policy(), descriptor), fetchB = net.fetchGoogle(await policy(), descriptor);
  const responses: Response[] = [];
  for (let i = 0; i < 64; i++) responses.push(await (i % 2 ? fetchA : fetchB)("https://gmail.googleapis.com/test"));
  expect(net.googlePending()).toBe(64);
  await responses[0]!.body!.cancel();
  expect(net.googlePending()).toBe(64);
  await expect(fetchA("https://gmail.googleapis.com/denied")).rejects.toBeInstanceOf(ProviderCooldownError);
  expect(transport).toHaveBeenCalledTimes(64);
  await Promise.all(responses.slice(1).map((r) => r.body!.cancel()));
});
