// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { realSetup } from "./draft-presentation-r2-harness";
for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it.each(["missing", "unknown", "refused", "removed From"])(`${adapter}: strip reopens retained ${"%s"} work without reviving its old target`, async (state) => {
  const h = await realSetup(adapter), { withAccounts } = await import("@terno/store/conformance"), { showNewDraft, leaveNewDraft, sendDraft } = await import("~/lib/compose");
  try {
    const [a, b] = await withAccounts(h.store);
    const saved = (await h.client.call("drafts.save", { accountId: a!, mode: "new", to: [{ name: "Recipient", email: "recipient@example.test" }, ...(state === "removed From" ? [] : [{ name: "", email: "bob@" }])], bodyText: "exact saved work", bodyHtml: "<div><b>exact saved work</b></div>" }))!;
    await h.publish(saved);
    await h.client.call("drafts.delete", { id: saved.id, generation: saved.generation! });
    if (state !== "removed From") {
      await act(async () => { h.drafts.editDraft(h.key, { bodyText: "latest retained work", bodyHtml: "<div><b>latest retained work</b></div>" }); await h.drafts.flushDraft(h.key); });
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.recovery?.state).toBe("missing");
      if (state === "unknown") {
        h.drafts.setDraftTransport(async (method, p) => { if (method === "drafts.save") { await h.call(method, h.contract[method].params.parse(p)); throw new Error("acknowledgement lost"); } return h.call(method, h.contract[method].params.parse(p)); });
        await act(async () => h.drafts.copyDraft(h.key));
      }
      if (state === "refused") { await h.store.accounts.remove(a!); await act(async () => h.drafts.copyDraft(h.key)); }
      expect(h.drafts.useDrafts.getState().drafts[h.key]?.recovery?.state).toBe(state);
    } else await h.store.accounts.remove(a!);
    await act(async () => { h.app.setApp({ accounts: await h.store.accounts.list(), accountId: b! }); showNewDraft(h.key); });
    await act(async () => leaveNewDraft());
    const before = h.drafts.materialize(h.key)!;
    const rows = (await h.store.drafts.list()).length; h.methods.length = 0;
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click());
    expect(h.app.getApp().compose?.key).toBe(h.key);
    expect(h.host.querySelector('[data-testid="composer"]')).not.toBeNull();
    if (state !== "removed From") { const action = h.host.querySelector<HTMLButtonElement>('[data-testid="draft-save-copy"]')!; expect(action).not.toBeNull(); expect(action.tabIndex).toBeGreaterThanOrEqual(0); }
    else expect(h.host.querySelector('[data-testid="compose-from"]')).not.toBeNull();
    expect(h.drafts.materialize(h.key)).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision, bodyText: before.bodyText, bodyHtml: before.bodyHtml, toText: before.toText });
    expect(h.drafts.materialize(h.key)?.recovery).toEqual(before.recovery);
    await act(async () => { expect(await sendDraft(h.key)).toBe(false); });
    expect(h.methods.filter((method) => ["drafts.save", "drafts.delete", "compose.send"].includes(method))).toEqual([]);
    expect((await h.store.drafts.list()).length).toBe(rows);
  } finally { await h.cleanup(); }
});



it("valid-recipient removed-From work refuses Send locally before a submission RPC", async () => {
  const h = await realSetup("SQL"), { withAccounts } = await import("@terno/store/conformance"), { showNewDraft, sendDraft } = await import("~/lib/compose");
  try {
    const [a, b] = await withAccounts(h.store);
    const saved = (await h.client.call("drafts.save", { accountId: a!, to: [{ name: "Recipient", email: "recipient@example.test" }], bodyText: "exact local work" }))!;
    await h.publish(saved); await h.store.accounts.remove(a!);
    await act(async () => { h.app.setApp({ accounts: await h.store.accounts.list(), accountId: b! }); showNewDraft(h.key); });
    h.methods.length = 0;
    expect(h.drafts.materialize(h.key)?.recovery).toBeUndefined();
    await act(async () => { expect(await sendDraft(h.key)).toBe(false); });
    expect(h.methods).not.toContain("compose.send");
    expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, accountId: a!, bodyText: saved.bodyText });
  } finally { await h.cleanup(); }
});
