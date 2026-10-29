import { expect, it } from "vitest";
import { sendWarningTitle } from "./send-warning";

it("distinguishes unknown recipients, confirmed rejections and copy-only failures", () => {
  for (const sentCopy of ["saved", "unknown", "rejected"] as const) {
    expect(sendWarningTitle({ sentCopy, partialRecipients: false, recipientOutcomeUnknown: true })).toBe("actions.send.recipientUnknown");
    expect(sendWarningTitle({ sentCopy, partialRecipients: true })).toBe("actions.send.partial");
  }
  expect(sendWarningTitle({ sentCopy: "rejected", partialRecipients: false })).toBe("actions.send.copyWarning");
});
