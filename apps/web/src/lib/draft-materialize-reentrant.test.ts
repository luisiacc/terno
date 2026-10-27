import { expect, it, vi } from "vitest";
import { attachBody, createDraft, forgetDraft, materialize, useDrafts } from "./drafts";
import { newFields } from "./compose-fields";

it.each(["publication edit", "publication revert", "reader edit", "source replacement", "ordinary"] as const)("materialization preserves source changes during %s", (scenario) => {
  vi.useFakeTimers();
  const key = createDraft(newFields(1));
  let text = "first", armed = true, source: ReturnType<typeof attachBody>, replacement: ReturnType<typeof attachBody> | undefined;
  source = attachBody(key, () => {
    const captured = text;
    if (armed && scenario === "reader edit") { armed = false; text = "later"; source.changed(); }
    return { text: captured, html: `<p>${captured}</p>` };
  });
  try {
    source.changed();
    const off = useDrafts.subscribe((state, previous) => {
      if (!armed || state.drafts[key]?.bodyText !== "first" || previous.drafts[key]?.bodyText === "first") return;
      if (scenario === "publication edit" || scenario === "publication revert") {
        armed = false; text = "later"; source.changed();
        if (scenario === "publication revert") { text = "first"; source.changed(); }
      } else if (scenario === "source replacement") {
        armed = false; replacement = attachBody(key, () => ({ text: "replacement", html: "<p>replacement</p>" })); replacement.changed();
      }
    });
    try {
      if (scenario === "ordinary") expect(materialize(key)).toMatchObject({ bodyText: "first", bodyHtml: "<p>first</p>" });
      else {
        expect(() => materialize(key)).toThrow();
        expect(materialize(key)).toMatchObject({ bodyText: scenario === "source replacement" ? "replacement" : text, bodyHtml: `<p>${scenario === "source replacement" ? "replacement" : text}</p>` });
      }
    } finally { off(); }
  } finally { source.dispose(); replacement?.dispose(); forgetDraft(key); vi.useRealTimers(); }
});
