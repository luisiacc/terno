import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { RpcError, contract } from "@terno/core/rpc";
import { parseRaw } from "@terno/mail";
import { addRecipients, expect, stabilize, test } from "./fixtures";

test.use({ backendOptions: { smtpCapture: true } });
const ctx = { clientId: "send-admission-ui", origin: "dev" as const };
for (const language of ["en", "es"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`ordinary Send awaits durable identity and refuses lost-ACK replay (${language}, ${scheme})`, async ({ app: page, server }) => {
    await page.route("**/*", (route) => { const url = new URL(route.request().url()); return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort(); });
    await server.backend.server.invoke("settings.update", { theme: scheme, language, senderIcons: false }, ctx);
    await page.addInitScript((value) => localStorage.setItem("terno:language", value), language);
    await page.reload(); await page.locator("[data-ready]").waitFor();
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...args: unknown[]) => unknown> }).handlers;
    const save = handlers["drafts.save"]!, send = handlers["compose.send"]!;
    const submissions: ReturnType<typeof contract["compose.send"]["params"]["parse"]>[] = [];
    let release!: () => void, saves = 0, opId: string | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    handlers["drafts.save"] = async (...args) => { saves++; await gate; return save(...args); };
    handlers["compose.send"] = async (...args) => {
      submissions.push(contract["compose.send"].params.parse(args[0]));
      const result = await send(...args) as { opId: string };
      opId = result.opId;
      if (submissions.length === 1) throw new RpcError("TIMEOUT", "Synthetic response lost after admission");
      return result;
    };
    try {
      await page.keyboard.press("c"); await addRecipients(page, "compose-to", "recipient@example.test");
      await page.getByTestId("compose-subject").fill("Durable ordinary Send");
      const body = page.getByTestId("compose-body"); await body.fill("Exact authored work");
      await body.press("ControlOrMeta+Enter");
      await expect.poll(() => saves).toBe(1);
      await expect(page.getByTestId("compose-send")).toBeDisabled();
      await expect(body).toBeFocused(); await expect(body).toHaveText("Exact authored work");
      expect(submissions).toHaveLength(0); expect(server.smtp).toHaveLength(0);
      expect(await server.backend.server.invoke("ops.list", {}, ctx)).toEqual([]);
      await stabilize(page);
      expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
      mkdirSync("/tmp/terno-w01-b46/ui", { recursive: true });
      await page.screenshot({ path: `/tmp/terno-w01-b46/ui/${language}-${scheme}-saving.png` });
      release();
      await expect.poll(() => submissions.length).toBe(1);
      await expect(page.getByTestId("compose-send")).toBeEnabled();
      await expect(body).toBeFocused(); await expect(body).toHaveText("Exact authored work");
      expect(submissions[0]!.draftId).toEqual(expect.any(Number)); expect(submissions[0]!.draftRevision).toBeGreaterThan(0); expect(submissions[0]!.draftGeneration).toBeTruthy();
      await body.press("ControlOrMeta+Enter");
      await expect(page.getByTestId("compose-send")).toBeDisabled();
      await expect.poll(() => submissions.length).toBe(2);
      expect(submissions[1]!.draftId).toBe(submissions[0]!.draftId);
      await expect(body).toBeFocused(); await expect(body).toHaveText("Exact authored work");
      await expect.poll(() => server.smtp.length).toBe(1);
      expect((await parseRaw(server.smtp[0]!.raw)).text).toBe("Exact authored work");
      await expect.poll(async () => (await server.backend.store.ops.get(opId!))?.state).toBe("succeeded");
      expect(await server.backend.server.invoke("drafts.list", {}, ctx)).toEqual([]);
      await stabilize(page);
      expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
      await page.screenshot({ path: `/tmp/terno-w01-b46/ui/${language}-${scheme}-missing.png` });
    } finally { release(); handlers["drafts.save"] = save; handlers["compose.send"] = send; }
  });
}
