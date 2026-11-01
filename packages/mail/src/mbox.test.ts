import { ATTACHMENT_CHUNK, bytesBase64 } from "@terno/core";
import PostalMime from "postal-mime";
import { describe, expect, it, vi } from "vitest";
import { asctime, BODY_READ, MBOX_PIECE, mboxMessage, qpLine, stringBody, type MboxBody, type MboxChunkReader, type MboxMessage } from "./mbox";

const base: MboxMessage = {
  rfcMessageId: "m1@terno",
  inReplyTo: "p@x",
  references: ["r@x", "p@x"],
  from: { name: "Ana Pérez", email: "ana@example.com" },
  to: [{ name: "Luis, C.", email: "luis@example.com" }],
  cc: [{ name: "", email: "cc@example.com" }],
  replyTo: [{ name: "Lista", email: "list@example.com" }],
  date: Date.UTC(2024, 0, 3, 10, 4, 5),
  subject: "Reunión del lunes",
  listId: "team.example.com",
  bodyText: "hola",
  bodyHtml: null,
  partial: false,
  attachments: [],
};

const none: MboxChunkReader = async () => null;

async function serialize(m: MboxMessage, read: MboxChunkReader = none) {
  const pieces: string[] = [];
  const it = mboxMessage(m, read);
  for (let r = await it.next(); ; r = await it.next()) {
    if (r.done) return { text: pieces.join(""), pieces, stats: r.value };
    pieces.push(r.value);
  }
}

/** mboxrd reading: messages split at their envelope lines, one `>` taken off quoted From lines */
function readMbox(text: string): string[] {
  return text
    .split(/^From - .*\n/m)
    .slice(1)
    .map((m) => m.replace(/\n\n$/, "\n").replace(/^>(>*From )/gm, "$1"));
}

describe("mbox (plan 107)", () => {
  it("writes the stored headers, encoded and folded, and round-trips through a MIME parser", async () => {
    const { text, stats } = await serialize({ ...base, references: Array.from({ length: 12 }, (_, i) => `ref-${i}@example.com`) });
    expect(text.startsWith("From - Wed Jan  3 10:04:05 2024\n")).toBe(true);
    expect(text).toContain("Message-ID: <m1@terno>\n");
    expect(text).toContain("In-Reply-To: <p@x>\n");
    expect(text).toContain("List-Id: <team.example.com>\n");
    expect(text).toContain("Date: Wed, 03 Jan 2024 10:04:05 +0000\n");
    expect(text).toContain('To: "Luis, C." <luis@example.com>\n');
    expect(text).not.toContain("Reunión");
    expect(text).not.toContain("X-Terno-");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(stats).toEqual({ missingAttachments: 0, partialBody: false });
    const [raw] = readMbox(text);
    const email = await PostalMime.parse(raw!);
    expect(email.subject).toBe("Reunión del lunes");
    expect(email.from).toMatchObject({ name: "Ana Pérez", address: "ana@example.com" });
    expect(email.to).toEqual([expect.objectContaining({ name: "Luis, C.", address: "luis@example.com" })]);
    expect(email.cc).toEqual([expect.objectContaining({ address: "cc@example.com" })]);
    expect(email.replyTo).toEqual([expect.objectContaining({ name: "Lista", address: "list@example.com" })]);
    expect(email.messageId).toBe("<m1@terno>");
    expect(email.inReplyTo).toBe("<p@x>");
    expect(email.references?.split(/\s+/)).toHaveLength(12);
    expect(email.text?.trim()).toBe("hola");
  });

  it("quotes From lines (mboxrd) and keeps the body exact", async () => {
    const body = "From here\n>From there\n>>From deep\nFromage\nlínea con espacio final \n=3D literal\n" + "x".repeat(200);
    const { text } = await serialize({ ...base, bodyText: body, bodyHtml: "<p>From html</p>" });
    // nothing but the envelope starts a line with From
    expect(text.split("\n").filter((l) => l.startsWith("From "))).toHaveLength(1);
    expect(text).toContain("\n>>>From deep");
    expect(text.endsWith("\n\n")).toBe(true);
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(78);
    const email = await PostalMime.parse(readMbox(text)[0]!);
    expect(email.text?.replace(/\r\n/g, "\n").trimEnd()).toBe(body);
    expect(email.html?.trim()).toBe("<p>From html</p>");
  });

  it("quoted-printable: soft breaks within 76, trailing space and the leading From encoded", () => {
    expect(qpLine("From x")).toEqual(["=46rom x"]);
    expect(qpLine("a ")).toEqual(["a=20"]);
    expect(qpLine("ñ=")).toEqual(["=C3=B1=3D"]);
    const long = qpLine("é".repeat(40));
    expect(long.every((l) => l.length <= 76)).toBe(true);
    expect(long.slice(0, -1).every((l) => l.endsWith("=") && !/=[0-9A-F]?=$/.test(l.slice(0, -1)))).toBe(true);
  });

  it("a body of one 5 MB line is encoded a slice at a time, in bounded pieces, exact (Codex code review #2)", async () => {
    // a surrogate pair and a multi-byte character across every slice edge, a trailing space at the very end
    const body = "From x " + "a😀ñ= \t".repeat(5 * 1024 * 1024 / 7) + " ";
    const { pieces, text } = await serialize({ ...base, bodyText: body });
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(MBOX_PIECE);
    expect(pieces.length).toBeGreaterThan(40);
    expect(pieces.every((p) => p.endsWith("\n"))).toBe(true);
    const email = await PostalMime.parse(readMbox(text)[0]!);
    expect(email.text?.replace(/\r\n/g, "\n").replace(/\n$/, "")).toBe(body);
  });

  it("a 10 MB body of short lines is read as it goes, never split whole (Codex code review round 5 #3)", async () => {
    const body = Array.from({ length: 10 * 1024 * 1024 / 16 }, (_, i) => `line ${String(i).padStart(9, "0")}`).join("\n");
    // splitting it all before the first piece was ~169 ms in one next(): no string op may see more than a piece
    const split = vi.spyOn(String.prototype, "split");
    try {
      const it = mboxMessage({ ...base, bodyText: body }, none);
      const pieces: string[] = [];
      for (let r = await it.next(); !r.done; r = await it.next()) pieces.push(r.value);
      expect(Math.max(0, ...split.mock.contexts.map((s) => String(s).length))).toBeLessThanOrEqual(MBOX_PIECE);
      const email = await PostalMime.parse(readMbox(pieces.join(""))[0]!);
      expect(email.text?.replace(/\r\n/g, "\n").replace(/\n$/, "")).toBe(body);
    } finally {
      split.mockRestore();
    }
  });

  it("a 20 MB stored body is read a stretch at a time as it's written, exact across the stretches' edges (Codex code review round 6 #4)", async () => {
    // a CRLF, a surrogate pair and a long "From " line, each across a stretch's edge; short lines and an empty one
    const edge = BODY_READ;
    const head = `${"x".repeat(edge - 1)}\r\nFrom ${"a😀".repeat(edge)} \n\n`;
    const body = head + Array.from({ length: (20 * 1024 * 1024 - head.length) / 16 }, (_, i) => `line ${String(i).padStart(9, "0")}`).join("\n");
    const store = stringBody(body);
    const asked: number[] = [];
    let before = 0;
    const read: MboxBody = (at, size) => {
      asked.push(size);
      return store(at, size);
    };
    const it = mboxMessage({ ...base, bodyText: read }, none);
    const pieces: string[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) {
      // the first piece comes after a stretch or two, never the whole body
      if (!pieces.length) before = asked.length;
      pieces.push(r.value);
    }
    expect(before).toBeLessThanOrEqual(2);
    expect(Math.max(...asked)).toBeLessThanOrEqual(BODY_READ);
    expect(asked.length).toBeGreaterThanOrEqual(Math.ceil(body.length / BODY_READ));
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(MBOX_PIECE);
    const text = pieces.join("");
    expect(text).toContain("\n=46rom a");
    const email = await PostalMime.parse(readMbox(text)[0]!);
    expect(email.text?.replace(/\r\n/g, "\n").replace(/\n$/, "")).toBe(body.replace("\r\n", "\n"));
  });

  it("a body gone while it's read ends there and counts as partial", async () => {
    const gone: MboxBody = async (at) => (at === 0 ? { text: "first\nsecond", next: 12 } : null);
    const { text, stats } = await serialize({ ...base, bodyText: gone });
    expect(stats.partialBody).toBe(true);
    expect((await PostalMime.parse(readMbox(text)[0]!)).text?.trim()).toBe("first\nsecond");
  });

  it("several messages read back one by one", async () => {
    const a = await serialize(base);
    const b = await serialize({ ...base, rfcMessageId: "m2@terno", subject: "Second", bodyText: "From the second" });
    const messages = readMbox(a.text + b.text);
    expect(messages).toHaveLength(2);
    expect((await PostalMime.parse(messages[1]!)).text?.trim()).toBe("From the second");
  });

  it("names attachments that aren't here and a partial body, and counts them", async () => {
    const bytes = new Uint8Array([0, 255, 128, 7]);
    const read: MboxChunkReader = async (attachment, index) => (attachment === 1 && index === 0 ? bytesBase64(bytes) : null);
    const { text, stats } = await serialize({
      ...base,
      partial: true,
      bodyText: null,
      bodyHtml: "<b>hi</b>",
      attachments: [
        { filename: "contrato firmado.pdf", mime: "application/pdf", size: 900_000, contentId: null, stored: false },
        { filename: "imagen.png", mime: "image/png", size: 4, contentId: "c1@x", stored: true },
        { filename: "Presupuesto €.xlsx", mime: "bad type", size: 10, contentId: null, stored: false },
      ],
    }, read);
    expect(stats).toEqual({ missingAttachments: 2, partialBody: true });
    expect(text).toContain("X-Terno-Missing-Attachment: contrato firmado.pdf\n");
    expect(text).toContain("X-Terno-Missing-Attachment: =?UTF-8?B?");
    expect(text).toContain("X-Terno-Partial-Body: true\n");
    const email = await PostalMime.parse(readMbox(text)[0]!);
    // an unknown header isn't decoded by the parser: its encoded words are
    const word = (v: string) => v.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))));
    const missing = email.headers.filter((h) => h.key === "x-terno-missing-attachment").map((h) => word(h.value));
    expect(missing).toEqual(["contrato firmado.pdf", "Presupuesto €.xlsx"]);
    expect(email.html?.trim()).toBe("<b>hi</b>");
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ filename: "imagen.png", mimeType: "image/png", contentId: "<c1@x>" });
    expect(new Uint8Array(email.attachments[0]!.content as ArrayBuffer)).toEqual(bytes);
  });

  it("a non-ASCII attachment name round-trips", async () => {
    const read: MboxChunkReader = async () => bytesBase64(new Uint8Array([1, 2, 3]));
    const { text } = await serialize({ ...base, attachments: [{ filename: "año ñandú.txt", mime: "text/plain", size: 3, contentId: null, stored: true }] }, read);
    const email = await PostalMime.parse(readMbox(text)[0]!);
    expect(email.attachments[0]?.filename).toBe("año ñandú.txt");
  });

  it("a chunk that's gone mid-way ends the part and counts it missing", async () => {
    const chunk = bytesBase64(new Uint8Array(ATTACHMENT_CHUNK).fill(7));
    const read: MboxChunkReader = async (_, index) => (index === 0 ? chunk : null);
    const { text, stats } = await serialize({ ...base, attachments: [{ filename: "a.bin", mime: "application/octet-stream", size: ATTACHMENT_CHUNK * 3, contentId: null, stored: true }] }, read);
    expect(stats.missingAttachments).toBe(1);
    expect(text).toContain("--=_terno_mixed--\n");
  });

  it("streams a 40 MB attachment in bounded pieces of whole 76-character lines", async () => {
    const size = 40 * 1024 * 1024 + 5;
    const chunks = Math.ceil(size / ATTACHMENT_CHUNK);
    const full = bytesBase64(new Uint8Array(ATTACHMENT_CHUNK).map((_, i) => i % 251));
    const last = bytesBase64(new Uint8Array(size - (chunks - 1) * ATTACHMENT_CHUNK).fill(9));
    let reads = 0;
    const read: MboxChunkReader = async (_, index) => {
      reads++;
      return index === chunks - 1 ? last : full;
    };
    const it = mboxMessage({ ...base, attachments: [{ filename: "big.bin", mime: "application/octet-stream", size, contentId: null, stored: true }] }, read);
    let pieces = 0;
    let b64 = 0;
    let largest = 0;
    let inPart = false;
    let carry = "";
    for (let r = await it.next(); !r.done; r = await it.next()) {
      pieces++;
      largest = Math.max(largest, r.value.length);
      expect(r.value.endsWith("\n")).toBe(true);
      // only the pieces; none is kept
      for (const line of (carry + r.value).split("\n").slice(0, -1)) {
        if (line === "Content-Transfer-Encoding: base64") inPart = true;
        else if (inPart && line.startsWith("--")) inPart = false;
        else if (inPart && line) {
          expect(line.length).toBeLessThanOrEqual(76);
          b64 += line.length;
        }
      }
      carry = "";
    }
    expect(reads).toBe(chunks);
    expect(largest).toBeLessThanOrEqual(MBOX_PIECE);
    expect(pieces).toBeGreaterThan(200);
    expect(b64).toBe(Math.ceil(size / 3) * 4);
  });

  it("asctime pads the day with a space", () => {
    expect(asctime(Date.UTC(2026, 10, 1, 3, 4, 5))).toBe("Sun Nov  1 03:04:05 2026");
  });
});
