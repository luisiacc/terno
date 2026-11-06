// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const chunk = { fail: false, arrive: () => {}, arrived: Promise.resolve() };
const pick = vi.fn();

async function picker() {
  vi.resetModules();
  vi.doMock("./when-fields", async () => {
    await chunk.arrived;
    if (chunk.fail) throw new Error("offline");
    return { WhenFields: () => <div data-testid="the-fields" /> };
  });
  const { SendLaterPicker } = await import("./send-later-picker");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<SendLaterPicker onPick={pick} done={() => {}} />));
  return {
    host,
    click: (id: string) => act(async () => host.querySelector<HTMLButtonElement>(`[data-testid=${id}]`)!.click()),
    set: () => host.querySelector<HTMLButtonElement>("[data-testid=send-later-set]")!,
    has: (id: string) => host.querySelector(`[data-testid=${id}]`) !== null,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r))));

beforeEach(() => {
  pick.mockClear();
  chunk.fail = false;
  chunk.arrived = new Promise((resolve) => (chunk.arrive = () => resolve()));
});
afterEach(() => vi.doUnmock("./when-fields"));

it("Custom clicked before its fields are in can't schedule the moment nobody has seen", async () => {
  const p = await picker();
  await p.click("send-later-custom");
  expect(p.has("the-fields")).toBe(false);
  expect(p.set().disabled).toBe(true);
  await p.click("send-later-set");
  expect(pick).not.toHaveBeenCalled();
  chunk.arrive();
  await settle();
  expect(p.has("the-fields")).toBe(true);
  expect(p.set().disabled).toBe(false);
  await p.close();
});

it("fields that fail to load say so and can be retried; the choices still work", async () => {
  const p = await picker();
  chunk.fail = true;
  chunk.arrive();
  await settle();
  await p.click("send-later-custom");
  expect(p.has("when-failed")).toBe(true);
  expect(p.set().disabled).toBe(true);

  chunk.fail = false;
  await p.click("when-retry");
  await settle();
  expect(p.has("when-failed")).toBe(false);
  expect(p.has("the-fields")).toBe(true);
  expect(p.set().disabled).toBe(false);

  await p.click("send-later-tomorrow");
  expect(pick).toHaveBeenCalledOnce();
  await p.close();
});
