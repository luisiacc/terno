/// <reference types="node" />
/**
 * public/theme.js runs before React with nothing but localStorage and
 * matchMedia: executed here in a vm sandbox with fakes of both.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { motionVars } from "@terno/ui/themes/apply";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(import.meta.dirname, "../../public/theme.js"), "utf8");

function run(options: { storage?: Record<string, string>; dark?: boolean; reduced?: boolean; opaque?: boolean; desktop?: string } = {}) {
  const store = new Map(Object.entries(options.storage ?? {}));
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  const style = { colorScheme: "", setProperty: (k: string, v: string) => void props.set(k, v) };
  const html = {
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c), contains: (c: string) => classes.has(c) },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    style,
  };
  const sandbox = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
    matchMedia: (q: string) => ({ matches: q.includes("dark") ? !!options.dark : q.includes("reduced-motion") ? !!options.reduced : q.includes("reduced-transparency") ? !!options.opaque : false }),
    document: { documentElement: html },
    window: options.desktop ? { ternoDesktop: { platform: options.desktop } } : {},
  };
  runInNewContext(SOURCE, sandbox);
  return { classes, attrs, props, style, store };
}

describe("theme.js", () => {
  it("shows the vibrancy on macOS desktop unless the OS asks for reduced transparency", () => {
    expect(run({ desktop: "darwin" }).attrs.has("data-vibrancy")).toBe(true);
    expect(run({ desktop: "darwin", opaque: true }).attrs.has("data-vibrancy")).toBe(false);
    expect(run({ desktop: "linux" }).attrs.has("data-vibrancy")).toBe(false);
  });

  it("defaults: system mode on a light OS, Única claro, motion 75", () => {
    const r = run();
    expect(r.classes.has("dark")).toBe(false);
    expect(r.attrs.get("data-theme")).toBe("terno-light");
    expect(r.attrs.get("data-motion")).toBe("on");
    expect(r.style.colorScheme).toBe("light");
    expect(r.attrs.has("data-vibrancy")).toBe(false);
  });

  it("follows the OS in system mode and uses that mode's theme", () => {
    const appearance = JSON.stringify({ mode: "system", light: "github-light", dark: "dracula", motion: 75, vibrancy: { light: false, dark: false } });
    const dark = run({ storage: { "terno:appearance": appearance }, dark: true });
    expect(dark.classes.has("dark")).toBe(true);
    expect(dark.attrs.get("data-theme")).toBe("dracula");
    expect(dark.style.colorScheme).toBe("dark");
    expect(run({ storage: { "terno:appearance": appearance }, dark: false }).attrs.get("data-theme")).toBe("github-light");
  });

  it("computes the same motion variables as motionVars()", () => {
    for (const ms of [0, 50, 75, 100]) {
      const r = run({ storage: { "terno:appearance": JSON.stringify({ mode: "light", light: "terno-light", dark: "terno-dark", motion: ms }) } });
      for (const [k, v] of Object.entries(motionVars(ms))) expect(r.props.get(k), `${ms} ${k}`).toBe(v);
      expect(r.attrs.get("data-motion")).toBe(ms === 0 ? "off" : "on");
    }
  });

  it("reduced motion turns motion off whatever the setting", () => {
    const r = run({ storage: { "terno:appearance": JSON.stringify({ mode: "light", light: "terno-light", dark: "terno-dark", motion: 100 }) }, reduced: true });
    expect(r.attrs.get("data-motion")).toBe("off");
  });

  it("migrates the v1 unica:theme key once", () => {
    const r = run({ storage: { "unica:theme": "dark" } });
    expect(r.store.has("terno:theme")).toBe(false);
    expect(r.classes.has("dark")).toBe(true);
    expect(r.attrs.get("data-theme")).toBe("terno-dark");
    expect(r.store.has("unica:theme")).toBe(false);
    expect(JSON.parse(r.store.get("terno:appearance")!)).toMatchObject({ mode: "dark", light: "terno-light", dark: "terno-dark", motion: 75 });
  });

  it("applies a cached custom theme over its base, dropping anything that isn't a plain color", () => {
    const appearance = { mode: "dark", light: "terno-light", dark: "custom:rosa", motion: 50, custom: { dark: { base: "dracula", tokens: { primary: "oklch(0.7 0.2 0)", background: "#101010", foreground: "red;}body{display:none", "x;y": "#fff", ring: "url(https://x.test)" } } } };
    const r = run({ storage: { "terno:appearance": JSON.stringify(appearance) } });
    expect(r.attrs.get("data-theme")).toBe("dracula");
    expect(r.props.get("--primary")).toBe("oklch(0.7 0.2 0)");
    expect(r.props.get("--background")).toBe("#101010");
    expect(r.props.has("--foreground")).toBe(false);
    expect(r.props.has("--x;y")).toBe(false);
    expect(r.props.has("--ring")).toBe(false);
  });

  it("ignores a tampered or broken cache", () => {
    expect(run({ storage: { "terno:appearance": "{not json" } }).attrs.get("data-theme")).toBe("terno-light");
    expect(run({ storage: { "terno:appearance": JSON.stringify({ mode: "light", light: '"]{}body{', motion: 999 }) } }).attrs.get("data-theme")).toBe("terno-light");
    expect(run({ storage: { "terno:appearance": JSON.stringify({ mode: "light", light: "x", motion: 999 }) } }).props.get("--motion")).toBe("75ms");
  });

  it("flags the macOS shell and vibrancy only for themes that allow it", () => {
    const allow = run({ desktop: "darwin" });
    expect([...allow.classes]).toEqual(expect.arrayContaining(["is-desktop", "is-mac"]));
    expect(allow.attrs.has("data-vibrancy")).toBe(true);
    const named = run({ desktop: "darwin", storage: { "terno:appearance": JSON.stringify({ mode: "light", light: "github-light", dark: "terno-dark", motion: 75, vibrancy: { light: false, dark: true } }) } });
    expect(named.attrs.has("data-vibrancy")).toBe(false);
    expect(run({ desktop: "linux" }).attrs.has("data-vibrancy")).toBe(false);
  });
});

describe("theme.js: keys from when the app was called Única", () => {
  it("moves every unica:* key to terno:* once, the default mailbox's pin included, and paints from it", () => {
    const appearance = JSON.stringify({ mode: "dark", light: "unica-light", dark: "unica-dark", motion: 50 });
    const r = run({ storage: { "unica:appearance": appearance, "unica:first-run": "done", "unica:storage:unica": "idb", "unica:storage:demo": "opfs-sqlite", "unica:mac-banner-dismissed-at": "1", other: "x" } });
    expect(Object.fromEntries(r.store)).toEqual({ "terno:appearance": appearance, "terno:first-run": "done", "terno:storage:terno": "idb", "terno:storage:demo": "opfs-sqlite", "terno:mac-banner-dismissed-at": "1", other: "x" });
    // the cached legacy theme id paints as its successor
    expect(r.attrs.get("data-theme")).toBe("terno-dark");
    expect(r.props.get("--motion")).toBe("50ms");
  });

  it("never overwrites a key that already has its Terno name, and keeps the legacy one then", () => {
    const r = run({ storage: { "unica:first-run": "account", "terno:first-run": "done" } });
    expect(r.store.get("terno:first-run")).toBe("done");
    expect(r.store.get("unica:first-run")).toBe("account");
  });
});
