import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { LinkReceiver, receiveLinks } from "./mail-links";

const LINK = "terno://message/caf3x%2B9%40mail.gmail.com";

describe("links reaching main (plan 201)", () => {
  it("a link that launches Terno waits for a window, then opens; later ones open at once", () => {
    const opened: string[] = [];
    const app = new EventEmitter();
    const r = new LinkReceiver((id) => opened.push(id));
    receiveLinks(app, ["/Applications/Terno.app/Contents/MacOS/Terno"], r);
    let prevented = false;
    app.emit("open-url", { preventDefault: () => (prevented = true) }, LINK);
    expect(prevented).toBe(true);
    expect(opened).toEqual([]);
    r.ready();
    expect(opened).toEqual(["caf3x+9@mail.gmail.com"]);
    app.emit("open-url", { preventDefault() {} }, "terno://message/second%40x");
    expect(opened).toEqual(["caf3x+9@mail.gmail.com", "second@x"]);
  });

  it("takes a link from a cold start's arguments and a second launch's; the newest held one wins", () => {
    const opened: string[] = [];
    const r = new LinkReceiver((id) => opened.push(id));
    receiveLinks(new EventEmitter(), ["electron", "dist/main.cjs", "--demo", LINK], r);
    r.argv(["terno", "terno://message/newer%40x"]);
    r.ready();
    expect(opened).toEqual(["newer@x"]);
    r.argv(["terno", "--flag", "terno://message/third%40x", "terno://message/fourth%40x"]);
    expect(opened).toEqual(["newer@x", "third@x"]);
  });

  it("ignores anything that isn't a link to a message", () => {
    const opened: string[] = [];
    const r = new LinkReceiver((id) => opened.push(id));
    r.ready();
    const app = new EventEmitter();
    receiveLinks(app, ["https://example.com", "terno://settings"], r);
    app.emit("open-url", { preventDefault() {} }, "terno://message/a/b");
    app.emit("open-url", { preventDefault() {} }, "javascript:alert(1)");
    r.url(42);
    expect(opened).toEqual([]);
  });
});
