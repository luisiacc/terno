import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devToolsAllowed, packagedApp, PROTOCOL_SWITCHES, refusedProtocolSwitch } from "./debugging";

// Plan 283 (CASA 6.2.1): a packaged Terno opens neither DevTools nor the DevTools protocol.
describe("main: no debugging in a packaged app", () => {
  const switches = (...on: string[]) => (name: string) => on.includes(name);

  it("refuses the DevTools protocol in a packaged app unless Node's inspector is running (only an inspectable build can start one)", () => {
    for (const s of PROTOCOL_SWITCHES) {
      expect(refusedProtocolSwitch({ packaged: true, inspectorUrl: undefined, hasSwitch: switches(s) })).toBe(s);
      // Playwright's launch of an inspectable package: --inspect=0 beside it
      expect(refusedProtocolSwitch({ packaged: true, inspectorUrl: "ws://127.0.0.1:9229/x", hasSwitch: switches(s) })).toBeNull();
      // the dev server and the source smoke run
      expect(refusedProtocolSwitch({ packaged: false, inspectorUrl: undefined, hasSwitch: switches(s) })).toBeNull();
    }
    expect(refusedProtocolSwitch({ packaged: true, inspectorUrl: undefined, hasSwitch: switches() })).toBeNull();
  });

  it("a package renamed `electron` (which Electron reads as unpackaged) is still packaged: it loads from the asar (Codex review)", () => {
    expect(packagedApp(true, "/Applications/Terno.app/Contents/Resources/app.asar/dist")).toBe(true);
    expect(packagedApp(false, "/home/u/copy/resources/app.asar/dist")).toBe(true);
    expect(packagedApp(false, "C:\\copy\\resources\\app.asar\\dist")).toBe(true);
    expect(packagedApp(false, "/Users/u/emailclient/apps/desktop/dist")).toBe(false);
  });

  it("opens DevTools only in an unpackaged run", () => {
    expect(devToolsAllowed(true)).toBe(false);
    expect(devToolsAllowed(false)).toBe(true);
  });

  it("every window main makes sets devTools from that rule (a window without it would have DevTools on)", () => {
    const files = readdirSync(__dirname, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const windows = files.flatMap((f) => {
      const text = readFileSync(join(__dirname, f), "utf8");
      return [...text.matchAll(/new BrowserWindow\(\{/g)].map((m) => {
        // the options object, to its closing `})`
        let depth = 0;
        let end = m.index! + "new BrowserWindow(".length;
        for (; end < text.length; end++) {
          if (text[end] === "{") depth++;
          else if (text[end] === "}" && --depth === 0) break;
        }
        return { file: f, options: text.slice(m.index!, end + 1) };
      });
    });
    expect(windows.map((w) => w.file).sort()).toEqual(["app.ts", "app.ts", "print.ts"]);
    for (const w of windows) expect(w.options, w.file).toMatch(/devTools(: devToolsAllowed\(packagedApp\(app\.isPackaged, __dirname\)\))?[,\s}]/);
  });
});
