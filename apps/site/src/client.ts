/**
 * The only script terno.app runs (plan 96): the page is complete HTML without it. It sends the waitlist in place
 * instead of navigating, and says how it went in the form's live region.
 */
import "./styles.css";

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-waitlist]")) {
  const status = form.querySelector<HTMLElement>("[data-status]")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const label = button.textContent ?? "";
  const message = (s: string) => form.querySelector(`[data-message="${s}"]`)?.textContent ?? "";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    button.disabled = true;
    button.textContent = form.dataset.sending ?? label;
    let outcome = "error";
    try {
      const res = await fetch(form.action, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(data) });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      outcome = json.ok ? "thanks" : (json.error ?? "error");
    } catch {}
    button.disabled = false;
    button.textContent = label;
    status.textContent = message(outcome);
    status.dataset.outcome = outcome === "thanks" ? "ok" : "error";
    if (outcome === "thanks") form.querySelector<HTMLInputElement>("input[type=email]")!.value = "";
  });
}
