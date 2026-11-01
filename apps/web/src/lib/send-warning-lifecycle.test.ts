import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpInfo } from "@terno/core/rpc";
import { client } from "~/rpc/connection";
import { clearRecipientDetails, installSendWarnings } from "./send-warning";
import { dismissSnack, registerUndo, resetSnacks, snack, snackRetentionForTests, useSnack } from "./snack";

vi.mock("~/rpc/connection", () => {
  const listeners = new Map<string, (value: never) => void>();
  return { client: { connectionVersion: 1, call: vi.fn(), on: (name: string, listener: (value: never) => void) => { listeners.set(name, listener); return () => listeners.delete(name); }, onClose: (listener: () => void) => { listeners.set("close", listener); return () => listeners.delete("close"); }, onAttach: (listener: () => void) => { listeners.set("attach", listener); return () => listeners.delete("attach"); }, emit: (name: string, value: unknown) => listeners.get(name)?.(value as never) } };
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

it.each(["before", "after"])("a rejected Clear with live receipt validation %s the pending read still announces the valid warning", async (order) => {
  let releaseWarning!: (part: string) => void, releaseValidation!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { releaseWarning = resolve as never; }));
  emit("op", op);
  vi.mocked(client.call).mockRejectedValueOnce(new Error("Clear refused"));
  const clearing = clearRecipientDetails(op.id);
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { releaseValidation = resolve as never; }));
  emit("recipientReceiptRetired", { opId: op.id });
  await expect(clearing).rejects.toThrow("Clear refused");
  if (order === "before") { releaseValidation("still live"); await settle(); }
  releaseWarning("still live"); await settle();
  if (order === "after") { releaseValidation("still live"); await settle(); }
  expect(useSnack.getState().current?.description).toBe("Mail server refused: private@example.test");
});

it.each(["success", "copy"])("delayed operation A cannot replace newer unrelated operation B %s feedback", async (result) => {
  let release!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("op", op);
  emit("op", { ...op, id: "receipt-B", partialRecipients: false, sentCopy: "rejected", lastError: result === "copy" ? "B copy failure" : null, lastErrorI18n: undefined });
  const newer = useSnack.getState().current;
  expect(newer).not.toBeNull();
  release("still-live A"); await settle();
  expect(useSnack.getState().current).toBe(newer);
});

it("a newer public snack queued behind Undo owns feedback before it becomes visible", async () => {
  const undo = registerUndo(() => {});
  snack("User Undo", { action: { label: "Undo", undo } });
  let release!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("op", op);
  snack.success("Newer queued feedback", { background: true });
  release("still live"); await settle();
  expect(useSnack.getState().undo).toBe(undo);
  dismissSnack();
  expect(useSnack.getState().current?.message).toBe("Newer queued feedback");
  dismissSnack();
  expect(useSnack.getState().current).toBeNull();
});

it("failed Clear restoration cannot steal newer feedback", async () => {
  let releaseWarning!: (part: string) => void, releaseValidation!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { releaseWarning = resolve as never; }));
  emit("op", op);
  vi.mocked(client.call).mockRejectedValueOnce(new Error("Clear refused"));
  const clearing = clearRecipientDetails(op.id);
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { releaseValidation = resolve as never; }));
  emit("recipientReceiptRetired", { opId: op.id });
  snack.success("Newer result", { background: true });
  const newer = useSnack.getState().current;
  await expect(clearing).rejects.toThrow("Clear refused");
  releaseValidation("still live"); releaseWarning("still live"); await settle();
  expect(useSnack.getState().current).toBe(newer);
});

it.each(["accounts", "close", "attach", "dispose"])("%s cancels pending private publication and leaves successor feedback alone", async (event) => {
  let release!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("op", op);
  if (event === "dispose") off(); else emit(event, []);
  release("old part"); await settle();
  expect(useSnack.getState().current).toBeNull();
});

it("a disposed retirement validation cannot withdraw a successor's valid warning", async () => {
  let release!: (part: null) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("recipientReceiptRetired", { opId: op.id });
  off(); off = installSendWarnings();
  vi.mocked(client.call).mockResolvedValue("successor live part" as never);
  emit("op", op); await settle();
  const successor = useSnack.getState().current;
  release(null); await settle();
  expect(useSnack.getState().current).toBe(successor);
});

it("a second acknowledged Clear fences both old read and repeated advisory validation", async () => {
  let release!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("op", op);
  vi.mocked(client.call).mockResolvedValue({ ok: true } as never);
  await clearRecipientDetails(op.id);
  await clearRecipientDetails(op.id);
  vi.mocked(client.call).mockResolvedValue(null as never);
  emit("recipientReceiptRetired", { opId: op.id });
  release("old part"); await settle();
  emit("op", op); await settle();
  expect(useSnack.getState().current).toBeNull();
  expect(snackRetentionForTests()).toEqual({ queued: [], displaced: [] });
});

it("an account refresh during Clear cannot leave acknowledged private feedback behind", async () => {
  vi.mocked(client.call).mockResolvedValue("live part" as never);
  emit("op", op); await settle();
  let acknowledge!: () => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { acknowledge = () => resolve({ ok: true } as never); }));
  const clearing = clearRecipientDetails(op.id);
  emit("accounts", []);
  acknowledge(); await clearing;
  expect(useSnack.getState().current).toBeNull();
  expect(useSnack.getState().last).toBeNull();
});

it("an ordinary account status refresh preserves a still-valid pending warning", async () => {
  let release!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
  emit("op", op);
  emit("accounts", [{ id: op.accountId, kind: "imap", email: "synthetic@example.test" }]);
  release("still live"); await settle();
  expect(useSnack.getState().current?.description).toBe("Mail server refused: private@example.test");
});

it("the newest pending operation keeps ownership when an older read settles first", async () => {
  let releaseA!: (part: string) => void, releaseB!: (part: string) => void;
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve as never; }));
  emit("op", op);
  vi.mocked(client.call).mockImplementationOnce(() => new Promise((resolve) => { releaseB = resolve as never; }));
  emit("op", { ...op, id: "receipt-B" });
  releaseA("A live"); await settle();
  expect(useSnack.getState().current).toBeNull();
  releaseB("B live"); await settle();
  expect(useSnack.getState().current?.id).toBe("recipient-warning-receipt-B");
});
