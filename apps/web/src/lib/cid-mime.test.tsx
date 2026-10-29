// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK, type AttachmentInfo, type AttachmentRef } from "@terno/core";
import { parseRaw } from "@terno/mail/portable";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
const { resolveCidHtml } = await import("./cid");
const { attachmentBlob, downloadAttachment } = await import("./attachments");

const gifA = [71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,44,0,0,0,0,1,0,1,0,0,2,1,76,0,59];
const gifB = [71,73,70,56,57,97,1,0,1,0,128,0,0,0,255,0,255,255,255,44,0,0,0,0,1,0,1,0,0,2,1,76,0,59];
const binary = new Uint8Array(ATTACHMENT_CHUNK + 3);
for (let i = 0; i < ATTACHMENT_CHUNK; i += 3) binary.set([0,255,128], i);
binary.set([13,10,42], ATTACHMENT_CHUNK);
const expected = [gifA, gifB, gifA, gifB, [...binary], [], gifB];
const names = ["same.gif", "same.gif", "attachment", "résumé 📨.gif", "report.bin", "attachment", "attachment"];
const ids = ["Photo@Test", "other@Test", "Part%25@Test", "unicode@Test", null, "empty@Test", "Part%@Test"];
const sourceHtml = '<p>Kept body</p><img src="CID:photo%40test"><img src="cid:OTHER@Test"><img src="cid:part%2525%40test"><img src="cid:unicode%40test"><img src="CID:part%25%40test"><img src="cid:part%broken"><img src="https://pixel.invalid/track">';

function rawMime(ambiguous = false, distinctNames = false) {
  const parts = [
    ['inline; filename="same.gif"', "Photo@Test", "image/gif", "base64", "R0lGODlhAQABAIAA\r\nAAAAAP///ywAAAAAAQABAAACAUwAOw=="],
    [`inline; filename="../${distinctNames ? "other" : "same"}.gif"`, ambiguous ? "pHoTo@tEsT" : "other@Test", "image/gif", "base64", "R0lGODlhAQABAIAAAAD/AP///ywAAAAAAQABAAACAUwAOw=="],
    ["inline", "Part%25@Test", "image/gif", "base64", "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="],
    ["inline; filename*0*=UTF-8''..%2F..%2F; filename*1*=r%C3%A9sum%C3%A9%20%F0%9F%93%A8.gif", "unicode@Test", "image/gif", "base64", "R0lGODlhAQABAIAAAAD/AP///ywAAAAAAQABAAACAUwAOw=="],
    ["attachment; filename*=UTF-8''..%5C..%5Creport%00%E2%80%AE.bin", null, "application/octet-stream", "quoted-printable", "=00=FF=80=\r\n".repeat(16384) + "=0D=0A=2A"],
    ['attachment; filename=".."', "empty@Test", "image/gif", "base64", ""],
    ["inline", "Part%@Test", "image/gif", "base64", "R0lGODlhAQABAIAAAAD/AP///ywAAAAAAQABAAACAUwAOw=="],
  ];
  return ["From: Sender <sender@example.test>", "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="s46"', "", "--s46", "Content-Type: text/html; charset=utf-8", "", sourceHtml,
    ...parts.flatMap(([disposition, cid, mime, encoding, data]) => ["--s46", `Content-Type: ${mime}`, `Content-Disposition: ${disposition}`, ...(cid ? [`Content-ID: <${cid}>`] : []), `Content-Transfer-Encoding: ${encoding}`, "", data]), "--s46--", ""].join("\r\n");
}

type LocalRef = AttachmentInfo & AttachmentRef;
async function fixture(ambiguous = false, distinctNames = false) {
  const parsed = await parseRaw(rawMime(ambiguous, distinctNames));
  // This adapter assigns synthetic local identities; ingestion/persistence are outside this fixture.
  const refs: LocalRef[] = parsed.attachments.map(({ bytes: _bytes, ...metadata }, i) => ({ ...metadata, id: i + 1, assetId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` }));
  const assets = new Map(refs.map((ref, i) => [ref.assetId, { ref, bytes: parsed.attachments[i]!.bytes! }]));
  call.mockImplementation(async (method: string, args: { accountId: number; assetId: string; index?: number }) => {
    const asset = assets.get(args.assetId);
    if (args.accountId !== 7 || !asset) throw new Error("Synthetic unavailable asset");
    if (method === "attachments.info") return asset.ref;
    if (method === "attachments.read" && args.index !== undefined) {
      const bytes = asset.bytes.subarray(args.index * ATTACHMENT_CHUNK, (args.index + 1) * ATTACHMENT_CHUNK);
      return { dataBase64: bytes.length ? Buffer.from(bytes).toString("base64") : null };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  return { parsed, refs, assets };
}

function trace(refs: AttachmentRef[], accountId = 7) {
  return refs.flatMap((ref) => [["attachments.info", { accountId, assetId: ref.assetId }], ...Array.from({ length: Math.ceil(ref.size / ATTACHMENT_CHUNK) }, (_, index) => ["attachments.read", { accountId, assetId: ref.assetId, index }])]);
}
function imageSources(html: string) {
  const template = document.createElement("template"); template.innerHTML = html;
  return [...template.content.querySelectorAll("img")].map((img) => img.getAttribute("src"));
}
function imageBytes(src: string | null | undefined) {
  expect(src).toMatch(/^data:image\/gif;base64,/);
  return [...Buffer.from(src!.slice("data:image/gif;base64,".length), "base64")];
}
async function expectDownloadBytes(values: Blob[]) {
  expect(await Promise.all(values.map(async (blob) => [...new Uint8Array(await blob.arrayBuffer())]))).toEqual(expected);
}

let blobs: Blob[], clicked: { href: string; name: string }[];
const revoke = vi.fn();
beforeEach(() => {
  blobs = []; clicked = [];
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL(blob: Blob) { blobs.push(blob); return `blob:s46-${blobs.length}`; }
    static override revokeObjectURL(url: string) { revoke(url); }
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ href: this.href, name: this.download }); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); call.mockReset(); revoke.mockReset(); });

it("raw MIME preserves distinct duplicate-name/CID bytes, decoded display labels and chunked downloads", async () => {
  const { parsed, refs } = await fixture();
  expect(parsed.html).toBe(sourceHtml);
  expect(parsed.attachments.map((a) => [...a.bytes!])).toEqual(expected);
  expect(refs.map((a) => a.filename)).toEqual(names);
  expect(refs.map((a) => a.contentId)).toEqual(ids);
  const output = await resolveCidHtml(parsed.html!, 7, refs, () => true);
  const sources = imageSources(output);
  expect(sources.slice(0, 5).map(imageBytes)).toEqual([gifA, gifB, gifA, gifB, gifB]);
  expect(sources.slice(5)).toEqual([null, "https://pixel.invalid/track"]);
  expect(output).toContain("<p>Kept body</p>");
  expect(call.mock.calls).toEqual(trace([refs[0]!, refs[1]!, refs[2]!, refs[3]!, refs[6]!]));
  call.mockClear(); vi.useFakeTimers();
  for (const ref of refs) await downloadAttachment(7, ref);
  await expectDownloadBytes(blobs);
  expect(clicked).toEqual(names.map((name, i) => ({ href: `blob:s46-${i + 1}`, name })));
  expect(call.mock.calls).toEqual(trace(refs));
  expect(revoke).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999); expect(revoke).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(revoke.mock.calls).toEqual(refs.map((_, i) => [`blob:s46-${i + 1}`]));
});

it("raw literal-percent IDs decode once, unmatched/malformed references and foreign message refs cause no reads", async () => {
  const { refs } = await fixture();
  const literal = refs[2]!;
  for (const src of ["cid:part%25%40test", "cid:part%broken", "cid:part%252525%40test"]) {
    expect(imageSources(await resolveCidHtml(`<img src="${src}">`, 7, [literal], () => true))).toEqual([null]);
  }
  expect(imageSources(await resolveCidHtml('<img src="cid:photo@test">', 7, [refs[1]!], () => true))).toEqual([null]);
  expect(call).not.toHaveBeenCalled();
  const otherMessage = { ...refs[1]!, contentId: "Photo@Test" };
  expect(imageBytes(imageSources(await resolveCidHtml('<img src="cid:photo@test">', 7, [otherMessage], () => true))[0])).toEqual(gifB);
  expect(call.mock.calls).toEqual(trace([otherMessage]));
  call.mockClear();
  expect(imageBytes(imageSources(await resolveCidHtml('<img src="CID:PHOTO%40TEST">', 7, [refs[0]!], () => true))[0])).toEqual(gifA);
  expect(call.mock.calls).toEqual(trace([refs[0]!]));
  call.mockClear();
  expect(imageSources(await resolveCidHtml('<img src="cid:photo@test">', 8, [refs[0]!], () => true))).toEqual([null]);
  expect(call.mock.calls).toEqual([["attachments.info", { accountId: 8, assetId: refs[0]!.assetId }]]);
});

async function qualifyAmbiguous(resolve: typeof resolveCidHtml = resolveCidHtml) {
  for (const distinctNames of [false, true]) {
    call.mockClear();
    const { refs } = await fixture(true, distinctNames);
    expect(refs.slice(0, 2).map((ref) => ref.filename)).toEqual(["same.gif", distinctNames ? "other.gif" : "same.gif"]);
    for (const pair of [refs.slice(0, 2), refs.slice(0, 2).reverse()]) {
      expect(imageSources(await resolve('<img src="cid:photo%40test">', 7, pair, () => true))).toEqual([null]);
    }
    expect(call).not.toHaveBeenCalled();
    const bytes = [];
    for (const ref of refs.slice(0, 2)) bytes.push([...new Uint8Array(await (await attachmentBlob(7, ref)).arrayBuffer())]);
    expect(bytes).toEqual([gifA, gifB]);
    expect(call.mock.calls).toEqual(trace(refs.slice(0, 2)));
  }
}

it("case-equivalent raw CIDs fail closed in either order while their assets remain downloadable", async () => {
  await qualifyAmbiguous();
});

it("ambiguous-CID qualification detects filename-dependent resolution", async () => {
  await expect(qualifyAmbiguous((html, account, refs, current) => {
    const supplied = new Set(refs.map((ref) => ref.filename)).size > 1 ? refs.slice(0, 1) : refs;
    return resolveCidHtml(html, account, supplied, current);
  })).rejects.toMatchObject({ name: "AssertionError", expected: [null], actual: [`data:image/gif;base64,${Buffer.from(gifA).toString("base64")}`] });
});

it("download qualification detects reversed chunk assembly", async () => {
  const values = expected.map((bytes) => new Blob([new Uint8Array(bytes)]));
  values[4] = new Blob([binary.subarray(ATTACHMENT_CHUNK), binary.subarray(0, ATTACHMENT_CHUNK)]);
  await expect(expectDownloadBytes(values)).rejects.toMatchObject({ name: "AssertionError", expected });
});

it("download sanitizes hostile matching ref/metadata labels without sending any label or path to RPC", async () => {
  const { refs, assets } = await fixture();
  const hostile = { ...refs[0]!, filename: "..\\../résumé 📨\u0000\u202e.gif" };
  assets.set(hostile.assetId, { ref: hostile, bytes: new Uint8Array(gifA) });
  vi.useFakeTimers(); await downloadAttachment(7, hostile);
  expect(clicked).toEqual([{ href: "blob:s46-1", name: "résumé 📨.gif" }]);
  expect([...new Uint8Array(await blobs[0]!.arrayBuffer())]).toEqual(gifA);
  expect(call.mock.calls).toEqual(trace([hostile]));
  await vi.runAllTimersAsync(); expect(revoke.mock.calls).toEqual([["blob:s46-1"]]);
});

it("sealed empty bytes differ from missing/unsealed assets and invalid nonempty reads fail before URL creation", async () => {
  const { refs, assets } = await fixture();
  const empty = refs[5]!;
  expect((await attachmentBlob(7, empty)).size).toBe(0);
  expect(call.mock.calls).toEqual(trace([empty]));
  call.mockClear();
  expect(imageSources(await resolveCidHtml('<img src="cid:empty@test">', 7, [empty], () => true))).toEqual([null]);
  expect(call.mock.calls).toEqual(trace([empty]));
  call.mockClear(); assets.delete(empty.assetId);
  await expect(downloadAttachment(7, empty)).rejects.toThrow("Synthetic unavailable asset");
  expect(call.mock.calls).toEqual(trace([empty])); expect(blobs).toEqual([]);
  const ref = refs[0]!;
  for (const dataBase64 of [null, "", "!!!!", Buffer.alloc(ref.size + 1).toString("base64")]) {
    call.mockReset(); call.mockImplementation(async (method: string) => method === "attachments.info" ? ref : { dataBase64 });
    await expect(downloadAttachment(7, ref)).rejects.toThrow();
    expect(call.mock.calls).toEqual(trace([ref])); expect(blobs).toEqual([]);
  }
  call.mockReset(); call.mockResolvedValue({ ...ref, filename: "other.gif" });
  await expect(downloadAttachment(7, ref)).rejects.toThrow();
  expect(call.mock.calls).toEqual([["attachments.info", { accountId: 7, assetId: ref.assetId }]]);
  expect(blobs).toEqual([]); expect(clicked).toEqual([]);
});

it("revoking an in-flight raw CID resolution publishes no bytes and starts no subsequent asset", async () => {
  const { refs } = await fixture();
  const delegate = call.getMockImplementation()!;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { reached = resolve; });
  call.mockImplementation(async (method: string, args: unknown) => {
    if (method === "attachments.read") { reached(); await gate; }
    return delegate(method, args);
  });
  let active = true;
  const input = '<img src="cid:photo@test"><img src="cid:other@test">';
  const pending = resolveCidHtml(input, 7, refs, () => active);
  try {
    await reading; active = false; release();
    expect(await pending).toBe(input);
    expect(call.mock.calls).toEqual(trace([refs[0]!]));
  } finally { active = false; release(); await pending; }
});

async function readerFixture(remoteImages: "ask" | "always" = "ask") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const { HtmlBody } = await import("../components/mail-body");
  const resolutions: Promise<string>[] = [];
  vi.spyOn(await import("./cid"), "resolveCidHtml").mockImplementation((...args) => {
    const pending = resolveCidHtml(...args); resolutions.push(pending); return pending;
  });
  const { useRemoteConsent } = await import("./remote-consent");
  const before = useRemoteConsent.getState().allowed;
  useRemoteConsent.setState({ allowed: new Set() });
  const { parsed, refs } = await fixture();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  const render = (key: number) => act(async () => root.render(<HtmlBody key={key} html={parsed.html!} messageId={key} accountId={7} attachments={refs} remoteImages={remoteImages} appearance="auto" />));
  await render(71);
  const doc = () => new DOMParser().parseFromString(host.querySelector("iframe")!.getAttribute("srcdoc")!, "text/html");
  const click = (id: string) => act(async () => (host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click());
  return { refs, host, doc, click, render, resolutions, useRemoteConsent, unmount, cleanup: async () => {
    try { await unmount(); await Promise.all(resolutions); }
    finally { host.remove(); useRemoteConsent.setState({ allowed: before }); }
  } };
}

it("HtmlBody keeps remote and inline consent separate, resolves exact bytes only after inline-load, and resets for another message", async () => {
  const h = await readerFixture();
  try {
    expect(call).not.toHaveBeenCalled();
    expect(h.doc().querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")).toContain("img-src data: cid:;");
    await h.click("inline-load");
    expect(h.resolutions).toHaveLength(1);
    await act(async () => { await Promise.all(h.resolutions); });
    expect(imageSources(h.doc().body.innerHTML).slice(0, 5).map(imageBytes)).toEqual([gifA, gifB, gifA, gifB, gifB]);
    expect(call.mock.calls).toEqual(trace([h.refs[0]!, h.refs[1]!, h.refs[2]!, h.refs[3]!, h.refs[6]!]));
    expect(h.useRemoteConsent.getState().allowed.size).toBe(0);
    expect(h.doc().querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")).toContain("img-src data: cid:;");
    call.mockClear(); await h.render(72);
    expect(call).not.toHaveBeenCalled(); expect(h.host.querySelector('[data-testid="inline-load"]')).not.toBeNull();
    await h.click("remote-load");
    expect(h.useRemoteConsent.getState().allowed).toEqual(new Set([72]));
    expect(call).not.toHaveBeenCalled();
    expect(h.resolutions).toHaveLength(1);
    expect(h.doc().querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")).toContain("img-src data: cid: https: http:;");
    expect(imageSources(h.doc().body.innerHTML)[0]).toBe("CID:photo%40test");
  } finally { await h.cleanup(); }
});

it("HtmlBody remote-always does not grant inline consent and unmount cancels pending publication", async () => {
  const h = await readerFixture("always");
  const delegate = call.getMockImplementation()!;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { reached = resolve; });
  let pendingRead: Promise<unknown> | undefined;
  call.mockImplementation((method: string, args: unknown) => {
    if (method !== "attachments.read") return delegate(method, args);
    reached(); pendingRead = gate.then(() => delegate(method, args)); return pendingRead;
  });
  try {
    expect(call).not.toHaveBeenCalled();
    await h.click("inline-load"); await reading;
    await h.unmount(); release();
    expect(h.resolutions).toHaveLength(1);
    await act(async () => { await pendingRead; await Promise.all(h.resolutions); });
    expect(h.host.innerHTML).toBe("");
    expect(call.mock.calls).toEqual(trace([h.refs[0]!]));
  } finally { release(); try { await pendingRead; } finally { await h.cleanup(); } }
});
