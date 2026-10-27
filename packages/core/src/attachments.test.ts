import { expect, it } from "vitest";
import { attachmentCid } from "./attachments";

it.each(["part%25@test", "part%@test", "cid:part%40@test", "<PHOTO%25@Test>"])("canonical Content-ID is idempotent: %s", (value) => {
  const canonical = value === "<PHOTO%25@Test>" ? "photo%25@test" : value;
  expect(attachmentCid(value)).toBe(canonical);
  expect(attachmentCid(attachmentCid(value))).toBe(canonical);
});
