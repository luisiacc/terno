import { describe, expect, it } from "vitest";
import { GMAIL_BLOCKED_EXTENSIONS, gmailBlocked, gmailNeedsWholeFile } from "./gmail-blocked";

// Plan 293 (CASA 5.2.1): exactly what https://support.google.com/mail/answer/6590 says Gmail won't send (2026-11-27).

const text = (s: string) => new TextEncoder().encode(s);

/** gzip with the platform's own CompressionStream (core is built without Node's or the DOM's types) */
async function gzipSync(data: Uint8Array): Promise<Uint8Array> {
  const g = globalThis as unknown as { Response: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> }; Blob: new (parts: unknown[]) => { stream(): { pipeThrough(t: unknown): unknown } }; CompressionStream: new (f: string) => unknown };
  return new Uint8Array(await new g.Response(new g.Blob([data]).stream().pipeThrough(new g.CompressionStream("gzip"))).arrayBuffer());
}
const bytes = (...b: number[]) => Uint8Array.from(b);

/** A stored (uncompressed) zip: local headers, the central directory, the end record. `encrypted` sets flag bit 0. */
function zip(files: { name: string; data?: Uint8Array; encrypted?: boolean }[]): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const le = (n: number, size: number) => Array.from({ length: size }, (_, i) => (n >>> (8 * i)) & 0xff);
  for (const f of files) {
    const name = [...text(f.name)];
    const data = [...(f.data ?? text("x"))];
    const offset = parts.length;
    const flags = f.encrypted ? 1 : 0;
    parts.push(...le(0x04034b50, 4), ...le(20, 2), ...le(flags, 2), ...le(0, 2), ...le(0, 4), ...le(0, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(name.length, 2), ...le(0, 2), ...name, ...data);
    central.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(flags, 2), ...le(0, 2), ...le(0, 4), ...le(0, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(name.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...name);
  }
  const cd = parts.length;
  return Uint8Array.from([...parts, ...central, ...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(files.length, 2), ...le(files.length, 2), ...le(central.length, 4), ...le(cd, 4), ...le(0, 2)]);
}

/** A ustar archive of regular files. */
function tar(names: string[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const name of names) {
    const h = new Uint8Array(512);
    h.set(text(name), 0);
    h.set(text("0000644\0"), 100);
    h.set(text("00000000001\0"), 124);
    h[156] = "0".charCodeAt(0);
    h.set(text("ustar\0"), 257);
    blocks.push(h, new Uint8Array(512).fill(0x41, 0, 1));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

describe("Gmail's blocked file types (plan 293)", () => {
  it("is the help page's list, word for word: 54 extensions", () => {
    expect(GMAIL_BLOCKED_EXTENSIONS).toHaveLength(54);
    expect(GMAIL_BLOCKED_EXTENSIONS.join(", ")).toBe(
      "ade, adp, apk, appx, appxbundle, bat, cab, chm, cmd, com, cpl, diagcab, diagcfg, diagpkg, dll, dmg, ex, ex_, exe, hta, img, ins, iso, isp, jar, jnlp, js, jse, lib, lnk, mde, mjs, msc, msi, msix, msixbundle, msp, mst, nsh, pif, ps1, scr, sct, shb, sys, vb, vbe, vbs, vhd, vxd, wsc, wsf, wsh, xll",
    );
  });

  it("refuses every listed type by name, in any case, and its .gz or .bz2 form", async () => {
    for (const ext of GMAIL_BLOCKED_EXTENSIONS) {
      expect(await gmailBlocked(`setup.${ext}`, text("hello"))).toEqual({ reason: "type", ext });
      expect(await gmailBlocked(`SETUP.${ext.toUpperCase()}`, text("hello"))).toEqual({ reason: "type", ext });
    }
    expect(await gmailBlocked("setup.exe.gz", bytes(0x1f, 0x8b))).toEqual({ reason: "type", ext: "exe" });
    expect(await gmailBlocked("script.js.bz2", text("BZh"))).toEqual({ reason: "type", ext: "js" });
  });

  it("looks inside a zip and a tar or tgz for a listed type, and refuses a password-protected zip with files in it", async () => {
    for (const name of ["photos.zip", "src.tar.gz", "src.tgz", "a.tar"]) expect(gmailNeedsWholeFile(name)).toBe(true);
    expect(await gmailBlocked("photos.zip", zip([{ name: "a.jpg" }, { name: "tools/install.msi" }]))).toEqual({ reason: "archive", ext: "msi" });
    expect(await gmailBlocked("invoice.zip", zip([{ name: "invoice.pdf.exe.gz" }]))).toEqual({ reason: "archive", ext: "exe" });
    expect(await gmailBlocked("secret.zip", zip([{ name: "dir/" }, { name: "report.pdf", encrypted: true }]))).toEqual({ reason: "protected" });
    expect(await gmailBlocked("src.tar", tar(["src/a.ts", "bin/run.bat"]))).toEqual({ reason: "archive", ext: "bat" });
    expect(await gmailBlocked("src.tgz", await gzipSync(tar(["README.md", "x/y/hack.ps1"])))).toEqual({ reason: "archive", ext: "ps1" });
    expect(await gmailBlocked("src.tar.gz", await gzipSync(tar(["README.md"])))).toBeNull();
  });

  it("refuses a program by its content, whatever its name: Windows (MZ), Linux (ELF), macOS (Mach-O thin or fat), an extensionless #! script", async () => {
    const head = (...b: number[]) => Uint8Array.from([...b, ...Array.from({ length: 60 }, () => 0)]);
    expect(await gmailBlocked("report.pdf", head(0x4d, 0x5a, 0x90, 0))).toEqual({ reason: "executable" });
    expect(await gmailBlocked("photo.jpg", head(0x7f, 0x45, 0x4c, 0x46))).toEqual({ reason: "executable" });
    for (const magic of [[0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe]]) expect(await gmailBlocked("notes.txt", head(...magic))).toEqual({ reason: "executable" });
    expect(await gmailBlocked("tool", head(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2))).toEqual({ reason: "executable" });
    expect(await gmailBlocked("deploy", text("#!/bin/sh\necho hi\n"))).toEqual({ reason: "executable" });
  });

  it("lets through what the page doesn't name: documents, named scripts, a Java class, archives of documents, and what it can't read", async () => {
    expect(await gmailBlocked("report.pdf", text("%PDF-1.7"))).toBeNull();
    expect(await gmailBlocked("deploy.sh", text("#!/bin/sh\n"))).toBeNull();
    expect(await gmailBlocked("notes.py", text("#!/usr/bin/env python3\n"))).toBeNull();
    // CAFEBABE with a class file's version (52), not a handful of architectures
    expect(await gmailBlocked("Main.class", bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52))).toBeNull();
    expect(await gmailBlocked("docs.zip", zip([{ name: "a.docx" }, { name: "b.xlsx" }]))).toBeNull();
    // not a zip at all, or a tgz that isn't gzip: Gmail decides
    expect(await gmailBlocked("broken.zip", text("not a zip"))).toBeNull();
    expect(await gmailBlocked("broken.tgz", text("not gzip"))).toBeNull();
    expect(await gmailBlocked("archive.rar", text("Rar!"))).toBeNull();
    expect(await gmailBlocked("", new Uint8Array())).toBeNull();
  });
});
