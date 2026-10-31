import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpInfo } from "@terno/core/rpc";
import { client } from "~/rpc/connection";
import { clearRecipientDetails, installSendWarnings } from "./send-warning";
import { dismissSnack, registerUndo, resetSnacks, snack, snackRetentionForTests, useSnack } from "./snack";

vi.mock("~/rpc/connection", () => {
  const listeners = new Map<string, (value: never) => void>();
  return { client: { connectionVersion: 1, call: vi.fn(), on: (name: string, listener: (value: never) => void) => { listeners.set(name, listener); return () => listeners.delete(name); }, onClose: () => () => {}, onAttach: () => () => {}, emit: (name: string, value: unknown) => listeners.get(name)?.(value as never) } };
});
const op: OpInfo = { id: "receipt-1", accountId: 1, kind: "send", state: "succeeded", attempts: 1, createdAt: 1, summary: "Synthetic", partialRecipients: true, lastError: "Mail server refused: private@example.test", lastErrorI18n: { key: "errors.smtp.notDeliveredTo", params: { recipients: "private@example.test" } } };
const emit = (name: string, value: unknown) => (client as unknown as { emit: (name: string, value: unknown) => void }).emit(name, value);
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
let off: () => void;
beforeEach(() => { resetSnacks(); vi.mocked(client.call).mockReset(); off = installSendWarnings(); });
afterEach(() => { off(); resetSnacks(); });

it.each(["visible", "queued", "displaced"])("acknowledged Clear fully withdraws %s feedback, preserving unrelated Undo", async (placement) => {
  vi.mocked(client.call).mockResolvedValue("synthetic-part" as never);
  const undo = registerUndo(() => {});
  if (placement === "displaced") snack.loading("Working", { id: "recipient-warning-receipt-1" });
  if (placement !== "visible") snack("Unrelated", { action: { label: "Undo", undo } });
  emit("op", op); await settle();
  if (placement === "visible") expect(useSnack.getState().current?.description).toContain("private@example.test");
  else expect(snackRetentionForTests().queued).toEqual(["recipient-warning-receipt-1"]);
  await clearRecipientDetails(op.id);
  expect(useSnack.getState().undo).toBe(undo);
  expect(snackRetentionForTests()).toEqual({ queued: [], displaced: [] });
  if (placement !== "visible") expect(useSnack.getState().current?.message).toBe("Unrelated");
  dismissSnack();
  expect(useSnack.getState().current).toBeNull();
  expect(useSnack.getState().last?.description ?? "").not.toContain("private@example.test");
});

it("failed Clear and its advisory event preserve still-valid visible details", async () => {
  vi.mocked(client.call).mockResolvedValue("synthetic-part" as never);
  emit("op", op); await settle();
  vi.mocked(client.call).mockRejectedValueOnce(new Error("Refused"));
  await expect(clearRecipientDetails(op.id)).rejects.toThrow("Refused");
  emit("recipientReceiptRetired", { opId: op.id }); await settle();
  expect(useSnack.getState().current?.description).toContain("private@example.test");
});

it("retirement fences a pending old publication and a later stale op cannot revive it", async () => {
  let release!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("op", op);
  vi.mocked(client.call).mockResolvedValue(null as never);
  emit("recipientReceiptRetired", { opId: op.id }); await settle();
  release("old private part"); await settle();
  expect(useSnack.getState().current).toBeNull();
  emit("op", op); await settle();
  expect(useSnack.getState().current).toBeNull();
});

it("retiring one receipt preserves a newer receipt and unrelated warning", async () => {
  vi.mocked(client.call).mockResolvedValue("synthetic-part" as never);
  emit("op", op); await settle();
  emit("op", { ...op, id: "receipt-2" }); await settle();
  await clearRecipientDetails(op.id);
  expect(useSnack.getState().current?.id).toBe("recipient-warning-receipt-2");
  emit("op", { ...op, lastError: "Unrelated copy failure", lastErrorI18n: undefined });
  await clearRecipientDetails("receipt-2");
  expect(useSnack.getState().current?.description).toBe("Unrelated copy failure");
});

it("a newer unrelated result fences the old recipient publication", async () => {
  let release!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("op", op);
  emit("op", { ...op, lastError: "Copy warning", lastErrorI18n: undefined });
  release("old part"); await settle();
  expect(useSnack.getState().current?.description).toBe("Copy warning");
});
