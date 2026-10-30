// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DraftFieldsForm } from "./inline-draft";
import { acquireDraftHold, createDraft, forgetDraft, useDrafts } from "~/lib/drafts";
import { newFields } from "~/lib/compose-fields";
import { focusSoon } from "~/lib/compose-focus-move";

vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.hoisted(() => {
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
});
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

for (const field of ["cc", "bcc", "subject"] as const) for (const successor of ["subject", "other", "none", "hold", "newer", "Tab", "unmount", "inert", "sending", "identity"] as const) {
  it(`${field} reveal respects ${successor} on a real next frame`, async () => {
    const key = createDraft(newFields(1));
    const host = document.createElement("div"), other = document.createElement("button");
    document.body.append(host, other);
    const root = createRoot(host);
    let mounted = true;
    try {
      await act(async () => root.render(<StrictMode><DraftFieldsForm d={useDrafts.getState().drafts[key]!} accounts={[]} showSubject={field !== "subject"} /></StrictMode>));
      const button = host.querySelector<HTMLButtonElement>(`[data-testid=compose-show-${field}]`)!;
      await act(async () => {
        button.focus();
        flushSync(() => button.click());
        if (successor === "subject") {
          const input = host.querySelector<HTMLInputElement>("[data-testid=compose-subject]")!;
          input.value = "Chosen subject"; input.focus(); input.setSelectionRange(2, 7, "backward");
        } else if (successor === "other") other.focus();
        else if (successor === "hold") { const release = acquireDraftHold(); expect(release).not.toBeNull(); release!(); }
        else if (successor === "newer") focusSoon("[data-missing]", other, 0);
        else if (successor === "inert") host.setAttribute("inert", "");
        else if (successor === "sending" || successor === "identity") {
          const draft = useDrafts.getState().drafts[key]!;
          useDrafts.setState({ drafts: { ...useDrafts.getState().drafts, [key]: { ...draft, ...(successor === "sending" ? { sending: true } : { generation: "replacement" }) } } });
        }
        else if (successor === "Tab") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        else if (successor === "unmount") { root.unmount(); mounted = false; }
        await frame(); await frame();
      });
      const target = host.querySelector(`[data-testid=compose-${field}]`);
      if (successor === "none") expect(document.activeElement).toBe(target);
      else if (successor === "subject") {
        const input = host.querySelector<HTMLInputElement>("[data-testid=compose-subject]")!;
        expect(document.activeElement).toBe(input);
        expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 7, "backward"]);
      } else if (successor === "other") expect(document.activeElement).toBe(other);
      else if (target) expect(document.activeElement).not.toBe(target);
    } finally {
      if (mounted) await act(async () => root.unmount());
      const draft = useDrafts.getState().drafts[key];
      if (draft?.sending) useDrafts.setState({ drafts: { ...useDrafts.getState().drafts, [key]: { ...draft, sending: false } } });
      forgetDraft(key); host.remove(); other.remove();
    }
  });
}

for (const action of ["pointer", "replacement", "isolation"] as const) it(`reveal cancellation and scope: ${action}`, async () => {
  const keys = [createDraft(newFields(1)), createDraft(newFields(1))];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<>{keys.map((key) => <DraftFieldsForm key={key} d={useDrafts.getState().drafts[key]!} accounts={[]} showSubject />)}</>));
    const forms = host.querySelectorAll<HTMLElement>("[data-draft-key]");
    await act(async () => {
      flushSync(() => forms[1]!.querySelector<HTMLButtonElement>("[data-testid=compose-show-cc]")!.click());
      if (action === "pointer") document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      if (action === "replacement") flushSync(() => forms[1]!.querySelector<HTMLButtonElement>("[data-testid=compose-show-bcc]")!.click());
      await frame(); await frame();
    });
    const expected = forms[1]!.querySelector(`[data-testid=compose-${action === "replacement" ? "bcc" : "cc"}]`);
    if (action === "pointer") expect(document.activeElement).not.toBe(expected);
    else expect(document.activeElement).toBe(expected);
    expect(forms[0]!.querySelector("[data-testid=compose-cc]")).toBeNull();
  } finally { await act(async () => root.unmount()); keys.forEach(forgetDraft); host.remove(); }
});
