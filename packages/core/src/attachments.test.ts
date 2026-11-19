import { expect, it } from "vitest";
import { attachmentCid, attachmentFilename, cidImageSources, inlineImageAdmission, messageParts } from "./attachments";

it.each(["part%25@test", "part%@test", "cid:part%40@test", "<PHOTO%25@Test>"])("canonical Content-ID is idempotent: %s", (value) => {
  const canonical = value === "<PHOTO%25@Test>" ? "photo%25@test" : value;
  expect(attachmentCid(value)).toBe(canonical);
  expect(attachmentCid(attachmentCid(value))).toBe(canonical);
});

it.each([
  ["a".repeat(119) + ".b", "a".repeat(119)],
  [" .. report. . ", "report"],
  ["../résumé 📨. ", "résumé 📨"],
  ["a".repeat(119) + "📨.pdf", "a".repeat(119)],
])("canonical filename is idempotent after truncation: %s", (value, canonical) => {
  expect(attachmentFilename(value)).toBe(canonical);
  expect(attachmentFilename(attachmentFilename(value))).toBe(canonical);
});

// plan 220: what a message's text shows, and so isn't listed as a file
const MiB = 1024 * 1024;
const part = (id: number, cid: string | null, o: { mime?: string; size?: number; assetId?: string | null } = {}) => ({
  id, contentId: cid, filename: `f${id}`, mime: o.mime ?? "image/png", size: o.size ?? 1000, ...(o.assetId === null ? {} : { assetId: o.assetId ?? `asset-${id}` }),
});
const ids = (html: string, parts: ReturnType<typeof part>[]) => messageParts(html, parts).images.map((a) => a.id);

it("finds the cid: sources of images only, in order, skipping what shows no image", () => {
  const html = `<p><img alt="a>b" src="cid:x"><IMG SRC='CID:One'><img data-src="cid:no" src=cid:two>`
    + `<!-- <img src="cid:comment"> --><textarea><img src="cid:text"></textarea><script>"<img src=cid:js>"</script>`
    + `<video src="cid:video"></video><img src="https://e.test/a.png"><img src="c&#105;d:enc&amp;1"><img src=" cid:space"><img/src="cid:slash"></p>`;
  // a > inside a quoted value ends the tag early: in doubt, nothing (a file stays a file)
  expect(cidImageSources(html)).toEqual(["CID:One", "cid:two", "cid:enc&1", "cid:slash"]);
  expect(cidImageSources(`<img src="cid:a"><img src="cid:b"`)).toEqual(["cid:a"]);
  expect(cidImageSources(`<img src="cid:a"><style><img src="cid:b">`)).toEqual(["cid:a"]);
});

it("a picture the reader shows is not a file; anything it wouldn't show stays one", () => {
  const parts = [
    part(1, "<logo@x>"), part(2, "doc@x", { mime: "application/pdf" }), part(3, "big@x", { size: 4 * MiB + 1 }),
    part(4, "gone@x", { assetId: null, size: 9 * MiB }), part(5, "twin@x"), part(6, "TWIN@x"), part(7, "unused@x"), part(8, null), part(9, "tiff@x", { mime: "image/tiff" }),
  ];
  const html = ["logo%40x", "doc@x", "big@x", "gone@x", "twin@x", "tiff@x"].map((c) => `<img src="cid:${c}">`).join("");
  expect(ids(html, parts)).toEqual([1]);
  expect(messageParts(html, parts).files.map((a) => a.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
});

it("a picture whose bytes aren't kept here is still the text's (its menu fetches it), and costs no budget", () => {
  const parts = [part(1, "unkept", { assetId: null, size: 4 * MiB }), part(2, "a", { size: 4 * MiB }), part(3, "b", { size: 3 * MiB })];
  // were the unkept one counted, 2 would no longer fit in the data URLs
  expect(ids(`<img src="cid:unkept"><img src="cid:a"><img src="cid:b">`, parts)).toEqual([1, 2]);
});

it("the message's budgets leave the later pictures listed", () => {
  // bytes: 8 MiB per message, each part once
  const bytes = [part(1, "a", { size: 3 * MiB }), part(2, "b", { size: 3 * MiB }), part(3, "c", { size: 3 * MiB }), part(4, "d", { size: 1000 })];
  expect(ids(`<img src="cid:a"><img src="cid:b"><img src="cid:c"><img src="cid:d">`, bytes)).toEqual([1, 4]);
  // data URLs: 8 MiB in the text, spent by each image shown (a repeated one too)
  const urls = [part(1, "a", { size: 2 * MiB }), part(2, "b", { size: 2 * MiB })];
  expect(ids(`<img src="cid:a"><img src="cid:a"><img src="cid:a"><img src="cid:b">`, urls)).toEqual([1]);
});

it("reserve and place keep the reader's order: a failed read keeps its bytes, spends no data URL", () => {
  const admission = inlineImageAdmission([part(1, "bad", { size: 4 * MiB }), part(2, "good", { size: 3 * MiB }), part(3, "late", { size: 2 * MiB })]);
  expect(admission.reserve("bad")?.id).toBe(1);
  expect(admission.reserve("good")?.id).toBe(2);
  // 1's read failed: nothing placed, so 2 fits
  expect(admission.place(admission.reserve("good")!)).toBe(true);
  expect(admission.reserve("late")).toBeNull();
});

it("parts are cached per array and body; a message without a kept Content-ID part isn't scanned", () => {
  const parts = [part(1, "a"), part(2, null, { mime: "application/pdf" })];
  const first = messageParts(`<img src="cid:a">`, parts);
  expect(messageParts(`<img src="cid:a">`, parts)).toBe(first);
  expect(messageParts(`<p>none</p>`, parts).files).toEqual(parts);
  const plain = [part(1, null)];
  expect(messageParts(`<img src="cid:a">`, plain).files).toBe(plain);
  expect(messageParts(null, parts).files).toBe(parts);
});
