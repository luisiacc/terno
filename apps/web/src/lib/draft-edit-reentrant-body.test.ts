import { expect, it, vi } from "vitest";
import { attachBody, createDraft, editDraft, forgetDraft, materialize, useDrafts } from "./drafts";
import { newFields } from "./compose-fields";

it.each(["change", "replacement"] as const)("retains a newer editor document created by %s during a body-patch notification", (scenario) => {
  vi.useFakeTimers();
  const key = createDraft(newFields(1));
  let body = "original";
  const source = attachBody(key, () => ({ text: body, html: `<p>${body}</p>` }));
  let replacement: ReturnType<typeof attachBody> | undefined;
  let stop = () => {};
  try {
    stop = useDrafts.subscribe((state, previous) => {
      if (state.drafts[key]?.bodyText === "external patch" && previous.drafts[key]?.bodyText !== "external patch") {
        stop(); body = "newer editor work";
        if (scenario === "replacement") { replacement = attachBody(key, () => ({ text: body, html: `<p>${body}</p>` })); replacement.changed(); }
        else source.changed();
      }
    });
    expect(editDraft(key, { bodyText: "external patch", bodyHtml: "<p>external patch</p>" })).toBe(true);
    expect(materialize(key)).toMatchObject({ bodyText: "newer editor work", bodyHtml: "<p>newer editor work</p>" });
  } finally { stop(); source.dispose(); replacement?.dispose(); forgetDraft(key); vi.useRealTimers(); }
});
