import { describe, expect, it } from "vitest";
import { createRegistry } from "./registry";
import { ProviderError, type ProviderContext } from "./types";

const ctx = (kind: "outlook") => ({ account: { id: 1, kind, email: "a@outlook.com" }, config: {} }) as unknown as ProviderContext;

describe("the registry per account kind (plan 259)", () => {
  it("refuses Outlook before its Graph provider exists, never handing it to IMAP", async () => {
    const provider = createRegistry().create(ctx("outlook"));
    const refusal = await provider.sync({} as never).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderError);
    expect((refusal as ProviderError).i18n?.key).toBe("errors.microsoft.notYet");
    await expect(provider.verify()).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.execute({ id: "1", kind: "send", target: {}, payload: {} })).rejects.toBeInstanceOf(ProviderError);
    await provider.close();
  });
});
