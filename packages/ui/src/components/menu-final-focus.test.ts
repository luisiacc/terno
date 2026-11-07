// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { menuFinalFocus } from "./menu-styles";

afterEach(() => { document.body.innerHTML = ""; });

describe("a menu's final focus as a function (plan 158)", () => {
  const decide = menuFinalFocus(() => true) as (closeType: never) => unknown;
  const focus = (html: string) => { document.body.innerHTML = html; (document.body.querySelector("[data-f]") as HTMLElement).focus(); };

  it("decides while focus is the menu's, a menu trigger's, or nowhere", () => {
    expect(decide(undefined as never)).toBe(true);
    focus(`<div role="menu"><button data-f>Forward</button></div>`);
    expect(decide(undefined as never)).toBe(true);
    focus(`<button aria-haspopup="menu" data-f>More</button>`);
    expect(decide(undefined as never)).toBe(true);
  });

  it("leaves focus the user already moved on (a draft that opened while the menu closed) where it is, and still asks the callback (its own cleanup)", () => {
    let asked = 0;
    const counted = menuFinalFocus(() => (asked++, true)) as (closeType: never) => unknown;
    focus(`<div contenteditable="true" data-f>Probe</div>`);
    expect(decide(undefined as never)).toBe(false);
    expect(counted(undefined as never)).toBe(false);
    expect(asked).toBe(1);
  });

  it("leaves a boolean or a ref to Base UI, which already keeps moved focus for those", () => {
    expect(menuFinalFocus(false)).toBe(false);
    expect(menuFinalFocus(undefined)).toBe(undefined);
  });
});
