// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { getApp, setApp } from "~/state/app";
import { forwardPrintKey } from "./print-open";

vi.hoisted(() => vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));

afterEach(() => setApp({ dialog: null, printTarget: null }));

it.each(["print", "pdf"] as const)("Escape from the mail frame dismisses %s during its pending initial focus", (intent) => {
  setApp({ dialog: "print", printTarget: { threadId: 7, messageId: null, intent } });
  const key = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  forwardPrintKey(key);
  expect(getApp().dialog).toBeNull();
  expect(getApp().printTarget).toBeNull();
  expect(key.defaultPrevented).toBe(true);
});

it("frame Escape leaves composition, consumed keys and other dialogs alone", () => {
  for (const dialog of ["palette", "settings", null, "print"] as const) {
    for (const mode of ["composing", "consumed", "plain"] as const) {
      if (dialog === "print" && mode === "plain") continue;
      setApp({ dialog, printTarget: null });
      const key = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, isComposing: mode === "composing" });
      if (mode === "consumed") key.preventDefault();
      forwardPrintKey(key);
      expect(getApp().dialog).toBe(dialog);
    }
  }
});
