import { create } from "zustand";

/**
 * Plan 204, the UI experiment: Today (What matters) drawn three ways from the same list, the same actions and the same
 * keys. `list` is today's thread rows (the default); `chat` is the owner's read-only feed of short notes, each with a way
 * to its email; `brief` keeps the headings and says each item in one plain sentence. Temporary: read at runtime, never
 * built in, so the panel's screenshots switch with `?wm=chat|brief|list` and Settings → Dev switches on this Mac.
 */
export type WmLook = "list" | "chat" | "brief";

export const WM_LOOKS: readonly WmLook[] = ["list", "chat", "brief"];
const KEY = "terno.wm.look";

const isLook = (v: unknown): v is WmLook => typeof v === "string" && (WM_LOOKS as readonly string[]).includes(v);

/** The URL's `?wm=` first (this load only), else this machine's choice, else the list. Storage can be missing or refuse. */
export function initialLook(search: string = globalThis.location?.search ?? "", stored: () => string | null = () => localStorage.getItem(KEY)): WmLook {
  const asked = new URLSearchParams(search).get("wm");
  if (isLook(asked)) return asked;
  try {
    const kept = stored();
    return isLook(kept) ? kept : "list";
  } catch {
    return "list";
  }
}

export const useWmLook = create<{ look: WmLook }>(() => ({ look: initialLook() }));

/** Settings → Dev: kept on this machine (a convenience: a refused write holds for the session). */
export function setWmLook(look: WmLook): void {
  try {
    localStorage.setItem(KEY, look);
  } catch {
    // this session only
  }
  useWmLook.setState({ look });
}

/** Today is on screen as a feed (chat or briefing), not as thread rows. */
export const feedLook = (today: boolean, look: WmLook): boolean => today && look !== "list";
