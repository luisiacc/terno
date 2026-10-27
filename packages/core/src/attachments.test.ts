import { expect, it } from "vitest";
import { attachmentCid, attachmentFilename } from "./attachments";

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
