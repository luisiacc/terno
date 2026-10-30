import { expect, it } from "vitest";
import { normalizeText } from "@terno/core";
import { recipientReceiptParts } from "./recipient-receipts";

it("bounds captured recipient parts and reserves UTF-8 bytes for outcome publication", async () => {
  const yieldTo = async () => {};
  const to = Array.from({ length: 3000 }, (_, i) => ({ name: `N${i}`, email: `recipient${i}@example.test` }));
  const receipt = await recipientReceiptParts({ to, cc: [], bcc: [] }, yieldTo);
  expect(receipt.parts.length).toBeGreaterThan(1);
  expect(receipt.parts.every((part) => new TextEncoder().encode(part).length <= 16384)).toBe(true);
  expect(receipt.count).toBe(3000);
  const expected = to.map((address) => `${address.name} ${address.email}`).join(" ");
  expect(receipt.text).toBe(expected); expect(receipt.normalized).toBe(normalizeText(expected));
  expect(receipt.charge).toBeGreaterThan(receipt.parts.reduce((n, part) => n + new TextEncoder().encode(part).length, 0));
  await expect(recipientReceiptParts({ to: [...to, to[0]!], cc: [], bcc: [] }, yieldTo)).rejects.toThrow();
  expect((await recipientReceiptParts({ to: [{ name: "ñ", email: "a@example.test" }], cc: [], bcc: [] }, yieldTo)).charge).toBeGreaterThan((await recipientReceiptParts({ to: [{ name: "n", email: "a@example.test" }], cc: [], bcc: [] }, yieldTo)).charge);
});

it("selects only proven rejected addresses from immutable occurrence parts", async () => {
  const { rejectedRecipients } = await import("./recipient-receipts");
  const header = { opId: "synthetic", accountId: 1, createdAt: 0, charge: 1000, count: 4, parts: 1, state: "accepted" as const, retired: false, childOpId: null, deleteAfter: 0, hasRejected: true, wireOwnerId: null };
  const values = { envelope: [JSON.stringify([{ role: "to", name: "", email: "yes@example.test" }, { role: "cc", name: "", email: "no@example.test" }, { role: "bcc", name: "", email: "maybe@example.test" }, { role: "to", name: "", email: "no@example.test" }])], outcomes: [JSON.stringify(["accepted", "rejected", "unknown", "rejected"])] };
  const read = async (kind: "envelope" | "outcomes", index: number) => values[kind][index] ?? null;
  expect(await rejectedRecipients(header, read, async () => {})).toEqual(["no@example.test"]);
  values.outcomes[0] = JSON.stringify(["accepted", "rejected", "unknown", "accepted"]);
  await expect(rejectedRecipients(header, read, async () => {})).rejects.toThrow();
  values.outcomes[0] = JSON.stringify(["accepted", "rejected", "unknown"]);
  await expect(rejectedRecipients(header, read, async () => {})).rejects.toThrow();
  values.outcomes[0] = JSON.stringify(["accepted", "rejected", "unknown", "rejected"]);
  values.envelope[0] = JSON.stringify([{ role: "to", email: "yes@example.test" }, { role: "cc", email: "no@example.test" }, { role: "bcc", email: "maybe@example.test" }, { role: "to", email: "NO@example.test" }]);
  await expect(rejectedRecipients(header, read, async () => {})).rejects.toThrow();
  values.envelope[0] = undefined as unknown as string;
  await expect(rejectedRecipients(header, read, async () => {})).rejects.toThrow();
});
