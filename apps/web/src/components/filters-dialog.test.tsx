// @vitest-environment jsdom
/**
 * Plan 161, pass 2 (the Codex review's second round): an unsaved AI rule survives being asked again and a Save of
 * another one. The backend's answers are held by the test, so what happens while one is out is what's tested.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const waiting: Record<string, Pending[]> = {};
const held = (method: string) => new Promise((resolve, reject) => (waiting[method] ??= []).push({ resolve, reject }));
const answer = async (method: string, value: unknown) => act(async () => waiting[method]!.shift()!.resolve(value));
const refuse = async (method: string) => act(async () => waiting[method]!.shift()!.reject(new Error("The model didn't answer.")));
let saved = 0;
vi.mock("~/rpc/connection", () => ({
  client: {
    call: vi.fn(async (method: string) => {
      if (method === "filters.list" || method === "learning.proposals") return [];
      if (method === "filters.preview") return { count: 0, sample: [] };
      if (method === "filters.generate" || method === "filters.save") return held(method);
      return null;
    }),
    on: () => () => {},
    connectionVersion: 1,
  },
}));
vi.mock("~/lib/ai", async (importOriginal) => ({ ...(await importOriginal<object>()), aiReady: () => true, privacyLine: () => "Nothing leaves this Mac." }));

const { FiltersDialog } = await import("./filters-dialog");
const { setApp } = await import("~/state/app");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: HTMLElement | null) => act(async () => el!.click());
const open = () => act(async () => {
  setApp({ dialog: "filters" });
  root.render(<FiltersDialog key={Math.random()} />);
});
// as a person closes it: Esc, through the dialog's own onOpenChange (pass 3: again, while Esc steps back a level); then
// Rules goes, as app.tsx unmounts it
const close = async () => {
  for (let i = 0; i < 3 && document.querySelector('[role="dialog"]'); i++)
    await act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await act(async () => root.render(<></>));
};
async function ask(text: string) {
  const field = $("ai-prompt") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click($("ai-generate"));
}
const rule = (value: string) => ({ name: value, rule: { match: "all", conditions: [{ field: "fromDomain", op: "equals", value }], actions: [{ type: "archive" }] } });
const names = () => $$("filter-unsaved").map((r) => r.querySelector("span")!.textContent);

beforeEach(async () => {
  for (const k of Object.keys(waiting)) delete waiting[k];
  setApp({ settings: { ai: { provider: "ollama", model: "m", local: true, needsKey: false, tasks: {}, keys: {} } } as never, accounts: [], categories: [], folders: [] } as never);
  await open();
  // what an earlier test kept, gone
  while ($("filter-unsaved-discard")) await click($("filter-unsaved-discard"));
});
afterEach(close);

it("asked again from Edit request and failing, or closed while it's out, the rule stays", async () => {
  await ask("archive mail from a.com");
  await answer("filters.generate", rule("a.com"));
  expect(names()).toEqual(["a.com"]);
  await click($("ai-edit-request"));
  await ask("archive mail from a.com, older than a week");
  // while it's out, the rule is still the one on screen and in the list
  expect(names()).toEqual(["a.com"]);
  await refuse("filters.generate");
  expect(names()).toEqual(["a.com"]);
  // and closing while a second try is out keeps it too
  await click($("ai-generate"));
  await close();
  await open();
  expect(names()).toEqual(["a.com"]);
  expect($("ai-explanation")?.textContent).toContain("a.com");
});

it("saving one while another is opened saves only that one: the other stays unsaved, and in the builder", async () => {
  await ask("archive mail from a.com");
  await answer("filters.generate", rule("a.com"));
  await click($("new-filter"));
  await ask("archive mail from b.com");
  await answer("filters.generate", rule("b.com"));
  expect(names()).toEqual(["a.com", "b.com"]);
  await click($("filter-save"));
  // A opened before B's Save answers
  await click($$("filter-unsaved")[0]!.querySelector("button"));
  await answer("filters.save", { id: ++saved, name: "b.com", enabled: true, source: "ai", rule: rule("b.com").rule, hits: 0 });
  expect(names()).toEqual(["a.com"]);
  expect($("filter-unsaved")!.dataset.open).toBe("true");
  expect(($("filter-name") as HTMLInputElement).value).toBe("a.com");
});

/** Plan 161, pass 3: Esc steps back a level before Rules closes, as in Ask and the actions. */
const esc = (el: Element) => act(async () => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
const isOpen = () => $("filters-dialog") !== null;

it("a rule AI built takes the focus on its line, a heading that says what was built", async () => {
  await ask("archive mail from a.com");
  await answer("filters.generate", rule("a.com"));
  expect(document.activeElement).toBe($("ai-explanation"));
  expect(document.activeElement!.tagName).toBe("H3");
  expect(document.activeElement!.textContent).toContain("a.com");
});

it("Esc with the request open again folds it back to the rule, and Rules stays", async () => {
  await ask("archive mail from a.com");
  await answer("filters.generate", rule("a.com"));
  await click($("ai-edit-request"));
  expect($("ai-prompt")).not.toBeNull();
  await esc($("ai-prompt")!);
  expect(isOpen()).toBe(true);
  expect($("ai-prompt")).toBeNull();
  expect($("ai-box")!.dataset.folded).toBe("true");
  expect(document.activeElement).toBe($("ai-edit-request"));
});

it("Esc in a field of the rule goes to its row in the list; Esc there closes", async () => {
  await ask("archive mail from a.com");
  await answer("filters.generate", rule("a.com"));
  $("filter-name")!.focus();
  await esc($("filter-name")!);
  expect(isOpen()).toBe(true);
  expect(document.activeElement?.closest("[data-testid=filter-unsaved]")).not.toBeNull();
  await esc(document.activeElement!);
  expect(isOpen()).toBe(false);
});

it("Esc in a new rule's name goes to New", async () => {
  $("filter-name")!.focus();
  await esc($("filter-name")!);
  expect(isOpen()).toBe(true);
  expect(document.activeElement).toBe($("new-filter"));
});
