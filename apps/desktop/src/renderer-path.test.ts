import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rendererFile } from "./renderer-path";

describe("main: app:// serves only the renderer's folder (plan 283)", () => {
  const root = "/Applications/Terno.app/Contents/Resources/app.asar/dist/renderer";

  it("serves a file in it, nested or not", () => {
    expect(rendererFile(root, "/index.html")).toBe(join(root, "index.html"));
    expect(rendererFile(root, "/assets/a/b.js")).toBe(join(root, "assets/a/b.js"));
    expect(rendererFile(root, "/assets/../index.html")).toBe(join(root, "index.html"));
  });

  it("refuses a sibling that shares its name as a prefix, a parent, and the folder itself", () => {
    expect(rendererFile(root, "/../renderer-old/x.js")).toBeNull();
    expect(rendererFile(root, "/../rendererX")).toBeNull();
    expect(rendererFile(root, "/../../main.cjs")).toBeNull();
    expect(rendererFile(root, "/..")).toBeNull();
    expect(rendererFile(root, "/")).toBeNull();
    // a name that only starts with two dots stays inside
    expect(rendererFile(root, "/..hidden")).toBe(join(root, "..hidden"));
  });
});
