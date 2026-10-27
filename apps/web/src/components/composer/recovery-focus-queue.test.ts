import { expect, it, vi } from "vitest";

const listener = vi.hoisted(() => ({ onNotify: () => {}, unsubscribe: () => {} }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useSyncExternalStore: (subscribe: (f: () => void) => () => void, snapshot: () => unknown) => {
    listener.unsubscribe = subscribe(() => listener.onNotify());
    return snapshot();
  } };
});

it("does not deliver a queued request canceled by a controller subscriber", async () => {
  const { useController, focusBody, cancelFocusBody, registerController } = await import("./controller");
  const key = "notify-cancel-focus";
  useController(key);
  const cancel = focusBody(key, "keep");
  listener.onNotify = () => { cancelFocusBody(key); };
  const focus = vi.fn();
  const unregister = registerController(key, { focus } as unknown as import("./controller").ComposerController);
  expect(focus).not.toHaveBeenCalled();
  listener.onNotify = () => {}; listener.unsubscribe(); cancel(); unregister();
});

it("does not replay an old request when a subscriber chooses a newer focus", async () => {
  const { useController, focusBody, cancelFocusBody, registerController } = await import("./controller");
  const key = "notify-new-focus";
  useController(key);
  const cancel = focusBody(key, "keep");
  listener.onNotify = () => { cancelFocusBody(key); focusBody(key, "end"); };
  const focus = vi.fn();
  const unregister = registerController(key, { focus } as unknown as import("./controller").ComposerController);
  expect(focus).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith("end");
  listener.onNotify = () => {}; listener.unsubscribe(); cancel(); unregister();
});
