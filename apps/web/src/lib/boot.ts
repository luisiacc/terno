import { client, connectBackend } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { invalidateThreads, loadThread } from "~/state/threads";
import { toast } from "sonner";

export function applyTheme(theme: "system" | "light" | "dark"): void {
  localStorage.setItem("unica:theme", theme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export async function boot(): Promise<void> {
  try {
    await connectBackend();
    const b = await client.call("app.bootstrap", {});
    applyTheme(b.settings.theme);
    setApp({ ready: true, accounts: b.accounts, categories: b.categories, counts: b.counts, settings: b.settings, version: b.version });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(getApp().settings?.theme ?? "system"));

    let refreshQueued = false;
    client.on("changed", ({ threadIds }) => {
      invalidateThreads(threadIds);
      const selected = getApp().selectedId;
      if (selected !== null && threadIds.includes(selected)) void loadThread(selected, true);
      // coalesce bursts (imports) into one refresh per frame
      if (refreshQueued) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        void reloadList({ keepSelection: true });
      });
    });
    client.on("counts", (counts) => setApp({ counts }));
    client.on("accounts", (accounts) => setApp({ accounts }));
    client.on("categories", (categories) => setApp({ categories }));
    client.on("op", (op) => {
      if (op.kind === "send" && op.state === "succeeded") {
        if (op.lastError) toast.warning("Enviado, pero no a todos", { description: op.lastError, duration: 12_000 });
        else toast.success("Correo enviado");
      }
      if (op.state === "unknown") toast.warning(`No sabemos si se envió: ${op.summary}`, { description: "Revisa Enviados antes de reintentar.", duration: 10_000 });
      if (op.state === "failed") toast.error(`Falló: ${op.summary}`, { description: op.lastError ?? undefined });
    });
    await reloadList();
  } catch (error) {
    setApp({ fatal: error instanceof Error ? error.message : String(error) });
  }
}
