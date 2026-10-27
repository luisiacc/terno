// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { act, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Account } from "@terno/core";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import SignInPanel from "./sign-in-panel";

const uiRequire = createRequire(resolve(process.cwd(), "packages/ui/package.json"));
const popoverEntry = uiRequire.resolve("@base-ui/react/popover");
const baseRequire = createRequire(popoverEntry);
const frameModule = await import(pathToFileURL(baseRequire.resolve("@base-ui/utils/useAnimationFrame").replace(/\.js$/, ".mjs")).href);
const { Popover: Primitive } = await import(pathToFileURL(popoverEntry.replace(/\.js$/, ".mjs")).href);

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));

const account = (id: number, kind: Account["kind"]) => ({ id, kind, email: `account${id}@example.test`, displayName: `Account ${id}`, color: "blue", senderName: "", signature: "", syncWindowDays: null, syncState: { authScope: null } }) as Account;
const first = account(1, "gmail"), second = account(2, "imap"), third = account(3, "gmail");

async function fixture(strict: boolean, run: (f: Awaited<ReturnType<typeof mount>>) => Promise<void>, keepMounted = false) {
  const f = await mount(strict, keepMounted);
  try { await run(f); } finally { await f.cleanup(); }
}

async function mount(strict: boolean, keepMounted: boolean) {
  const frames = new Map<number, FrameRequestCallback>(); let seq = 0;
  frameModule.resetAnimationFrameScheduler();
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++seq, cb); return seq; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const host = document.createElement("div"); document.body.append(host);
  const outside = document.createElement("button"); outside.textContent = "Other control"; document.body.append(outside);
  const root = createRoot(host);
  let accounts = [first, second], open = false, unmounted = false;
  const render = () => {
    const content = <SignInPanel accounts={accounts} onLater={() => {}} />;
    const props = { open, onOpenChange: (next: boolean) => { open = next; render(); } };
    const panel = keepMounted ? (
      <Primitive.Root {...props}>
        <Primitive.Trigger render={<button data-testid="restoration-trigger">Open</button>} />
        <Primitive.Portal keepMounted><Primitive.Positioner><Primitive.Popup data-testid="restoration-popup">{content}</Primitive.Popup></Primitive.Positioner></Primitive.Portal>
      </Primitive.Root>
    ) : (
      <Popover {...props}><PopoverTrigger render={<button data-testid="restoration-trigger">Open</button>} /><PopoverContent data-testid="restoration-popup">{content}</PopoverContent></Popover>
    );
    root.render(strict ? <StrictMode>{panel}</StrictMode> : panel);
  };
  const query = <T extends HTMLElement>(selector: string) => {
    const element = document.querySelector<T>(selector);
    expect(element, `fixture element ${selector}`).not.toBeNull();
    return element!;
  };
  const frame = async () => {
    const current = [...frames.values()]; frames.clear();
    await act(async () => { for (const cb of current) cb(performance.now()); });
  };
  const drain = async () => { for (let i = 0; i < 3; i++) await frame(); };
  const update = async (next: Account[]) => { accounts = next; await act(async () => render()); };
  const removeFocused = async (element: HTMLElement, next: Account[], afterRemoval?: () => void) => {
    expect(document.activeElement).toBe(element);
    // Explicit blur + removal models observed native focusout; jsdom removal itself does not.
    await act(async () => { element.blur(); accounts = next; flushSync(render); afterRemoval?.(); });
    expect(element.isConnected).toBe(false);
  };
  const close = async () => { await act(async () => { open = false; render(); }); };
  const unmount = async () => { await act(async () => root.unmount()); unmounted = true; };
  const cleanup = async () => {
    if (!unmounted) await unmount();
    await drain();
    host.remove(); outside.remove(); frameModule.resetAnimationFrameScheduler(); frames.clear();
    vi.restoreAllMocks(); raf.mockRestore(); cancel.mockRestore();
  };
  try {
    await act(async () => render());
    const trigger = query<HTMLButtonElement>('[data-testid="restoration-trigger"]');
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      // jsdom has no native keyboard activation; detail=0 models the resulting click.
      trigger.click();
    });
    await drain();
    const popup = query<HTMLElement>('[data-testid="restoration-popup"]');
    expect(popup.contains(document.activeElement), "keyboard activation model initially focuses panel").toBe(true);
    return { frames, query, frame, drain, update, removeFocused, close, unmount, cleanup, outside, trigger, popup };
  } catch (error) { await cleanup(); throw error; }
}

async function focus(element: HTMLElement) { await act(async () => element.focus()); }
async function typePassword(input: HTMLInputElement) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "partial");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(2, 5);
  });
}
function intact(input: HTMLInputElement) {
  expect(document.querySelector('[data-testid="sign-in-password"]')).toBe(input);
  expect(input.value).toBe("partial");
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
}
async function pending(f: Awaited<ReturnType<typeof mount>>) {
  const removed = f.query<HTMLButtonElement>('[data-account-id="1"] [data-sign-in-action]');
  await focus(removed);
  await f.removeFocused(removed, [second]);
  expect(document.activeElement).toBe(f.popup);
  expect(f.frames.size).toBeGreaterThan(0);
}

it.each([false, true])("keeps immediate and deferred restoration with no later choice (StrictMode: %s)", async (strict) => {
  await fixture(strict, async (f) => {
    await pending(f);
    const popupFocus = vi.spyOn(f.popup, "focus");
    await f.frame();
    expect(document.activeElement).toBe(f.popup);
    expect(popupFocus).toHaveBeenCalledOnce();
  });
});

const choices = ["password", "outside-after-password", "body-after-password", "outside-direct", "body-direct", "return-popup"] as const;
it.each(choices.flatMap((choice) => [false, true].map((strict) => ({ choice, strict }))))("honors $choice after removal (StrictMode: $strict)", async ({ choice, strict }) => {
  await fixture(strict, async (f) => {
    await pending(f);
    const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
    const later = f.query<HTMLButtonElement>('[data-testid="sign-in-later"]');
    const popupFocus = vi.spyOn(f.popup, "focus");
    if (choice === "password" || choice.endsWith("after-password")) await typePassword(input);
    if (choice.startsWith("outside")) await focus(f.outside);
    if (choice.startsWith("body") || choice === "return-popup") {
      await act(async () => { later.focus(); if (choice === "return-popup") f.popup.focus(); else later.blur(); });
    }
    const expected = choice === "password" ? input : choice.startsWith("outside") ? f.outside : choice === "return-popup" ? f.popup : document.body;
    expect(document.activeElement).toBe(expected);
    popupFocus.mockClear();
    await f.frame();
    expect(document.activeElement).toBe(expected);
    expect(popupFocus).not.toHaveBeenCalled();
    if (choice === "password" || choice.endsWith("after-password")) intact(input);
  });
});

for (const destination of ["password", "outside"] as const) {
  it.each([false, true])(`preserves ${destination} chosen after popup focus passes through body (StrictMode: %s)`, async (strict) => {
    await fixture(strict, async (f) => {
      await pending(f);
      const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
      await act(async () => f.popup.blur());
      expect(document.activeElement).toBe(document.body);
      if (destination === "password") await typePassword(input); else await focus(f.outside);
      const expected = destination === "password" ? input : f.outside;
      expect(document.activeElement).toBe(expected);
      const popupFocus = vi.spyOn(f.popup, "focus");
      await f.frame();
      expect(document.activeElement).toBe(expected);
      expect(popupFocus).not.toHaveBeenCalled();
      if (destination === "password") intact(input);
    });
  });
}

for (const destination of ["password", "outside"] as const) {
  it.each([false, true])(`does not revive restoration after body-gap ${destination} focus returns to body (StrictMode: %s)`, async (strict) => {
    await fixture(strict, async (f) => {
      await pending(f);
      const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
      await act(async () => f.popup.blur());
      expect(document.activeElement).toBe(document.body);
      if (destination === "password") await typePassword(input); else await focus(f.outside);
      const chosen = destination === "password" ? input : f.outside;
      expect(document.activeElement).toBe(chosen);
      await act(async () => chosen.blur());
      expect(document.activeElement).toBe(document.body);
      const popupFocus = vi.spyOn(f.popup, "focus");
      await f.frame();
      expect(document.activeElement).toBe(document.body);
      expect(popupFocus).not.toHaveBeenCalled();
      if (destination === "password") intact(input);
    });
  });
}

it.each([false, true])("still restores focus lost to body without a later destination (StrictMode: %s)", async (strict) => {
  await fixture(strict, async (f) => {
    await pending(f);
    await act(async () => f.popup.blur());
    expect(document.activeElement).toBe(document.body);
    const popupFocus = vi.spyOn(f.popup, "focus");
    await f.frame();
    expect(document.activeElement).toBe(f.popup);
    expect(popupFocus).toHaveBeenCalledOnce();
  });
});

it.each([false, true])("preserves a field revealed before account removal (StrictMode: %s)", async (strict) => {
  await fixture(strict, async (f) => {
    await act(async () => f.query<HTMLButtonElement>('[data-testid="sign-in-password-reveal"]').click());
    const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
    await typePassword(input);
    await pending(f);
    intact(input);
    await focus(input);
    await f.frame();
    expect(document.activeElement).toBe(input);
    intact(input);
  });
});

it.each([false, true])("rejects stale restoration detached in the same installed scheduler batch MODEL (StrictMode: %s)", async (strict) => {
  await fixture(strict, async (f) => {
    const helper = frameModule.AnimationFrame.create();
    let helperRan = false;
    helper.request(() => { helperRan = true; f.query<HTMLInputElement>('[data-testid="sign-in-password"]').focus(); });
    expect(f.frames.size, "helper schedules one native RAF").toBe(1);
    await pending(f);
    expect(f.frames.size, "helper and public Popover share ONE native RAF batch").toBe(1);
    const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
    const popupFocus = vi.spyOn(f.popup, "focus");
    await f.frame();
    expect(helperRan).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(popupFocus).not.toHaveBeenCalled();
  });
});

it.each([false, true])("honors synchronous popup focus redirection BEFORE frame request MODEL (StrictMode: %s)", async (strict) => {
  await fixture(strict, async (f) => {
    await act(async () => f.query<HTMLButtonElement>('[data-testid="sign-in-password-reveal"]').click());
    const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
    const order: string[] = [];
    // Observe the installed helper, retaining its real scheduling behavior.
    const realRequest = frameModule.AnimationFrame.prototype.request;
    vi.spyOn(frameModule.AnimationFrame.prototype, "request").mockImplementation(function (this: unknown, ...args: unknown[]) {
      order.push("frame-request");
      return Reflect.apply(realRequest, this, args);
    });
    const redirect = () => { order.push("popup-focus"); input.focus(); order.push("input-focus"); };
    f.popup.addEventListener("focus", redirect, { once: true });
    const removed = f.query<HTMLButtonElement>('[data-account-id="1"] [data-sign-in-action]');
    await focus(removed);
    await f.removeFocused(removed, [second]);
    expect(order).toEqual(["popup-focus", "input-focus", "frame-request"]);
    expect(document.activeElement).toBe(input);
    const popupFocus = vi.spyOn(f.popup, "focus");
    await f.frame();
    expect(document.activeElement).toBe(input);
    expect(popupFocus).not.toHaveBeenCalled();
  });
});

for (const destination of ["password", "outside"] as const) {
  it.each([false, true])(`honors ${destination} focus and blur before removal's microtask MODEL (StrictMode: %s)`, async (strict) => {
    await fixture(strict, async (f) => {
      await act(async () => f.query<HTMLButtonElement>('[data-testid="sign-in-password-reveal"]').click());
      const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
      const chosen = destination === "password" ? input : f.outside;
      const removed = f.query<HTMLButtonElement>('[data-account-id="1"] [data-sign-in-action]');
      await focus(removed);
      await f.removeFocused(removed, [second], () => { chosen.focus(); chosen.blur(); });
      expect(document.activeElement).toBe(document.body);
      const popupFocus = vi.spyOn(f.popup, "focus");
      await f.frame();
      expect(document.activeElement).toBe(document.body);
      expect(popupFocus).not.toHaveBeenCalled();
    });
  });
}

for (const destination of ["password", "outside"] as const) {
  it.each([false, true])(`keeps a synchronous body-gap ${destination} choice after it blurs MODEL (StrictMode: %s)`, async (strict) => {
    await fixture(strict, async (f) => {
      await act(async () => f.query<HTMLButtonElement>('[data-testid="sign-in-password-reveal"]').click());
      const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
      const chosen = destination === "password" ? input : f.outside;
      const redirect = () => { f.popup.blur(); chosen.focus(); chosen.blur(); };
      f.popup.addEventListener("focus", redirect, { once: true });
      const removed = f.query<HTMLButtonElement>('[data-account-id="1"] [data-sign-in-action]');
      await focus(removed);
      await f.removeFocused(removed, [second]);
      expect(document.activeElement).toBe(document.body);
      const popupFocus = vi.spyOn(f.popup, "focus");
      await f.frame();
      expect(document.activeElement).toBe(document.body);
      expect(popupFocus).not.toHaveBeenCalled();
    });
  });
}

it.each([false, true])("restores again when the later focused control is removed (StrictMode: %s)", async (strict) => {
  await fixture(strict, async (f) => {
    await pending(f);
    const input = f.query<HTMLInputElement>('[data-testid="sign-in-password"]');
    await focus(input);
    // Remove the new target while the old request is pending: a new restoration must be allowed.
    await f.update([second, third]);
    expect(document.querySelector('[data-testid="sign-in-password"]')).toBe(input);
    const popupFocus = vi.spyOn(f.popup, "focus");
    await f.removeFocused(input, [third]);
    expect(document.activeElement).toBe(f.popup);
    expect(popupFocus).toHaveBeenCalledOnce();
    popupFocus.mockClear();
    expect(f.frames.size).toBeGreaterThan(0);
    await f.frame();
    expect(document.activeElement).toBe(f.popup);
    expect(popupFocus).toHaveBeenCalledOnce();
  });
});

for (const mode of ["unmount", "controlled-close", "retained-close"] as const) {
  it.each([false, true])(`cleans pending restoration on ${mode} without an intervening focus choice (StrictMode: %s)`, async (strict) => {
    await fixture(strict, async (f) => {
      await pending(f);
      const popupFocus = vi.spyOn(f.popup, "focus");
      if (mode === "unmount") await f.unmount(); else await f.close();
      if (mode === "retained-close") expect(f.popup.isConnected).toBe(true);
      if (mode !== "unmount") expect(document.activeElement).toBe(f.trigger);
      const expected = document.activeElement;
      popupFocus.mockClear();
      await f.frame();
      expect(document.activeElement).toBe(expected);
      expect(popupFocus).not.toHaveBeenCalled();
    }, mode === "retained-close");
  });
}

it.each([false, true])("returns keyboard focus on Escape with no pending restoration (StrictMode: %s)", async (strict) => {
  await fixture(strict, async (f) => {
    await act(async () => f.popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
    await f.drain();
    expect(document.activeElement).toBe(f.trigger);
  });
});
