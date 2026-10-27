import { afterEach, expect, it, vi } from "vitest";
import type { Account, AttachmentRef, ThreadDetail } from "@terno/core";
import type { DraftInput } from "@terno/store";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { openCompose } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, editDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { setApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");
const { resetSnacks } = await import("./snack");
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); resetSnacks(); });

for (const size of [1024 * 1024, 3 * 1024 * 1024]) it(`complete Forward admission bounds preparation, escaping, assembly and budget scan (${size} quote characters)`, async () => {
  const account = { id: 1, email: "me@test.com", signature: "a short signature" } as Account;
  const ref: AttachmentRef = { assetId: "sealed-empty", filename: "empty.txt", mime: "text/plain", size: 0 };
  const original = "&".repeat(size);
  const detail: ThreadDetail = { thread: { id: 7, accountId: 1, subject: "source", snippet: "", lastDate: 0, fromName: "Sender", fromEmail: "sender@test.com", messageCount: 1, unread: false, starred: false, hasAttachments: true, categoryIds: [], inInbox: true, inTrash: false, inSpam: false }, messages: [{ id: 3, threadId: 7, replyTo: [], snippet: "", bodyHtml: null, bodyState: "full", isRead: true, isStarred: false, hasAttachments: true, rfcMessageId: null, references: [], listId: null, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "Sender", email: "sender@test.com" }, to: [], cc: [], subject: "source", date: 0, bodyText: original, attachments: [{ id: 1, ...ref }] }] };
  const key = createDraft(replyFields("reply", detail, account));
  editDraft(key, { bodyText: "preserved", bodyHtml: "<div>preserved</div>" });
  useThreads.setState({ details: new Map([[7, detail]]) });
  setApp({ accounts: [account], selectedId: 7, checked: new Set(), scope: null, draftShown: { threadId: 7, key } });
  rpc.mockImplementation(async () => { await new Promise<void>((r) => setImmediate(r)); return ref; });
  setDraftTransport(async (_method, p) => ({ ...(p as DraftInput), id: 9, generation: "generation", revision: 1, updatedAt: 0 }));
  let previous = process.threadCpuUsage(), maxCpu = 0, turns = 0, active = true;
  const record = () => { const cpu = process.threadCpuUsage(previous); maxCpu = Math.max(maxCpu, (cpu.user + cpu.system) / 1000); previous = process.threadCpuUsage(); };
  const heartbeat = () => { record(); turns++; if (active) timer = setImmediate(heartbeat); };
  let timer = setImmediate(heartbeat);
  try { await openCompose("forward", 7); record(); }
  finally { active = false; clearImmediate(timer); }
  process.stderr.write(`[complete Forward admission ${size}] ${turns} task turns; maxCPU ${maxCpu.toFixed(2)} ms\n`);
  expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: "forward", bodyText: "preserved", bodyHtml: "<div>preserved</div>", attachments: [{ ...ref, contentId: null }] });
  expect(useDrafts.getState().drafts[key]!.quotedText).toContain(original);
  expect(turns).toBeGreaterThan(100);
  expect(maxCpu).toBeLessThanOrEqual(15);
});
