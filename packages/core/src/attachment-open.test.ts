import { describe, expect, it } from "vitest";
import { browserPreviewType, opensInPlace } from "./attachment-open";

describe("opensInPlace (plan 212)", () => {
  it("opens documents and images by their extension, in any case", () => {
    for (const name of ["a.pdf", "B.PDF", "photo.JPeG", "scan.heic", "notes.txt", "sheet.xlsx", "deck.key", "x.tiff"]) expect(opensInPlace(name), name).toBe(true);
  });
  it("never opens what runs code, what an app acts on, video, audio, or a name without an extension", () => {
    for (const name of ["setup.app", "run.command", "x.sh", "macro.docm", "old.doc", "old.xls", "page.html", "logo.svg", "invite.ics", "card.vcf", "mail.eml", "files.zip", "clip.mov", "song.mp3", "README", ".pdf", "pdf", "trailing."]) expect(opensInPlace(name), name).toBe(false);
  });
  it("reads only the last extension, of the cleaned name", () => {
    expect(opensInPlace("invoice.pdf.app")).toBe(false);
    expect(opensInPlace("invoice.app.pdf")).toBe(true);
    // a path in the name is a label: only its leaf counts
    expect(opensInPlace("../../x.pdf/evil.command")).toBe(false);
    expect(opensInPlace("folder.app/report.pdf")).toBe(true);
    // trailing dots and spaces are cleaned away first, as the written file's name is
    expect(opensInPlace("report.pdf. ")).toBe(true);
    expect(opensInPlace("script.command‮")).toBe(false);
  });
  it("gives a browser only a type of its own, a subset of what the OS opens", () => {
    expect(browserPreviewType("a.PDF")).toBe("application/pdf");
    expect(browserPreviewType("a.jpg")).toBe("image/jpeg");
    for (const name of ["a.svg", "a.html", "a.txt", "a.heic", "a.docx"]) expect(browserPreviewType(name), name).toBeNull();
    for (const name of ["a.pdf", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp"]) expect(opensInPlace(name), name).toBe(true);
  });
});
