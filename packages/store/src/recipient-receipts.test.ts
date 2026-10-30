import { expect, it } from "vitest";
import { recipientReceiptParts } from "./recipient-receipts";

it("bounds captured recipient parts and reserves UTF-8 bytes for outcome publication", async () => {
  const yieldTo = async () => {};
  const to = Array.from({ length: 3000 }, (_, i) => ({ name: `N${i}`, email: `recipient${i}@example.test` }));
  const receipt = await recipientReceiptParts({ to, cc: [], bcc: [] }, yieldTo);
  expect(receipt.parts.length).toBeGreaterThan(1);
  expect(receipt.parts.every((part) => new TextEncoder().encode(part).length <= 16384)).toBe(true);
  expect(receipt.count).toBe(3000);
  expect(receipt.charge).toBeGreaterThan(receipt.parts.reduce((n, part) => n + new TextEncoder().encode(part).length, 0));
  await expect(recipientReceiptParts({ to: [...to, to[0]!], cc: [], bcc: [] }, yieldTo)).rejects.toThrow();
  expect((await recipientReceiptParts({ to: [{ name: "ñ", email: "a@example.test" }], cc: [], bcc: [] }, yieldTo)).charge).toBeGreaterThan((await recipientReceiptParts({ to: [{ name: "n", email: "a@example.test" }], cc: [], bcc: [] }, yieldTo)).charge);
});
