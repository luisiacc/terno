import { client, connectBackend } from "~/rpc/connection";
import { removeFromCategory } from "~/lib/categorize";
import { getApp, navigate, setApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { invalidateThreads, loadThread } from "~/state/threads";
import { toast } from "sonner";
import { applyAppearance, installAppearanceListeners, updateAppearance } from "~/lib/appearance";
import { exposeForTests } from "~/lib/render-probe";

export async function boot(): Promise<void> {
  try {
    await connectBackend();
    const b = await client.call("app.bootstrap", {});
    applyAppearance(b.settings);
    setApp({ ready: true, accounts: b.accounts, categories: b.categories, counts: b.counts, settings: b.settings, owner: b.owner, demo: b.demo, version: b.version });
    installAppearanceListeners();
    exposeForTests({ updateAppearance, getApp });

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
    client.on("owner", (owner) => setApp({ owner }));
    client.on("categorized", ({ categoryId, threadIds }) => {
      const name = getApp().categories.find((c) => c.id === categoryId)?.name;
      if (!name) return;
      const n = threadIds.length;
      toast(`Única añadió ${n} ${n === 1 ? "conversación" : "conversaciones"} a ${name}`, {
        id: `auto-${categoryId}`,
        duration: 8000,
        // undoing the engine is a correction: it learns from it
        action: { label: "Deshacer", onClick: () => void removeFromCategory(categoryId, threadIds, "user") },
        cancel: { label: "Ver", onClick: () => navigate({ categoryId }) },
      });
    });
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
