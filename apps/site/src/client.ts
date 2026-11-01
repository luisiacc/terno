/**
 * The only script terno.app runs (plan 97): the page is complete HTML without it. It sends the waitlist in place
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

// screenshots (parts/shot.tsx): the light/dark switch and the enlarged view; their tools show once this runs
document.documentElement.classList.add("js");
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const shownMode = (shot: HTMLElement) => shot.dataset.show ?? (document.documentElement.dataset.design === "midnight" || systemDark.matches ? "dark" : "light");
const syncShot = (shot: HTMLElement) => {
  const mode = shownMode(shot);
  for (const b of shot.querySelectorAll<HTMLButtonElement>("button[data-show]")) b.setAttribute("aria-pressed", String(b.dataset.show === mode));
};
const shots = [...document.querySelectorAll<HTMLElement>("[data-shot]")];
shots.forEach(syncShot);

// a frame bigger than what shows of it (Lumen's hero runs off a phone's edge, crops hide a frame's bottom): the
// tools move in to stay at the bottom right of the visible part (CSSOM, which the CSP allows)
function placeTools() {
  for (const shot of shots) {
    const tools = shot.querySelector<HTMLElement>(".site-shot-tools");
    const frame = tools?.offsetParent;
    if (!tools || !frame) continue;
    const box = frame.getBoundingClientRect();
    let right = Math.min(box.right, document.documentElement.clientWidth);
    let bottom = box.bottom;
    for (let el = frame.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (style.overflowX !== "visible") right = Math.min(right, r.right);
      if (style.overflowY !== "visible") bottom = Math.min(bottom, r.bottom);
    }
    const inset = (hidden: number, name: string) => {
      if (hidden > 0) tools.style.setProperty(name, `${Math.round(hidden + 10)}px`);
      else tools.style.removeProperty(name);
    };
    inset(box.right - right, "--tools-right");
    inset(box.bottom - bottom, "--tools-bottom");
  }
}
placeTools();
let placing = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(placing);
  placing = requestAnimationFrame(placeTools);
});
systemDark.addEventListener("change", () => shots.forEach(syncShot));

const lightbox = document.querySelector<HTMLDialogElement>("dialog[data-lightbox]");
const big = lightbox?.querySelector<HTMLImageElement>("[data-lightbox-img]");
// a double-click opens it with the first click; the second, landing on the backdrop, mustn't close it
let openedAt = 0;
function enlarge(shot: HTMLElement) {
  if (!lightbox || !big) return;
  const img = shot.querySelector<HTMLImageElement>(`img[data-mode="${shownMode(shot)}"]`);
  if (!img) return;
  big.src = img.dataset.full ?? img.currentSrc;
  big.alt = img.alt;
  openedAt = performance.now();
  lightbox.showModal();
}
lightbox?.addEventListener("click", (e) => {
  // the close button always; anywhere but the picture once the opening click (or double-click) is over
  const onClose = (e.target as Element).closest("[data-close]");
  if (onClose || (e.target !== big && performance.now() - openedAt > 400)) lightbox.close();
});
// Esc closes it whatever happened before (the browser's own handling can need a second press after a double-click)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && lightbox?.open) {
    e.preventDefault();
    lightbox.close();
  }
});
lightbox?.addEventListener("close", () => big?.removeAttribute("src"));

document.addEventListener("click", (e) => {
  const target = e.target as Element;
  const shot = target.closest<HTMLElement>("[data-shot]");
  if (!shot) return;
  const mode = target.closest<HTMLButtonElement>("button[data-show]");
  if (mode) {
    e.preventDefault();
    shot.dataset.show = mode.dataset.show;
    syncShot(shot);
  } else if (target.closest("button[data-zoom]") || (target instanceof HTMLImageElement && target.parentElement === shot)) {
    e.preventDefault();
    enlarge(shot);
  }
});
