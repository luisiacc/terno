import { expect, it } from "vitest";
import { createGmailTokenBroker } from "./gmail-web";
import { ProviderAuthError, type ProviderContext } from "./types";

it("forgets a removed account's browser token while a sibling remains usable", async () => {
  const broker = createGmailTokenBroker({ now: () => 1000 });
  const requests: string[] = [];
  const provider = (id: number) => broker.provider({ account: { id }, store: {}, config: {}, fetch: async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(new Headers(init?.headers).get("authorization")!);
    return Response.json({ historyId: "10" });
  } } as unknown as ProviderContext);
  broker.set(1, "first", 3601000);
  broker.set(2, "sibling", 3601000);
  const removed = provider(1), sibling = provider(2);
  try {
    await removed.verify();
    broker.forget?.(1);
    await expect(removed.verify()).rejects.toBeInstanceOf(ProviderAuthError);
    await sibling.verify();
    expect(requests).toEqual(["Bearer first", "Bearer sibling"]);
  } finally {
    await removed.close();
    await sibling.close();
  }
});
