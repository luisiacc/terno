import type { WhatMattersWordsState } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";

/**
 * Plan 248: What matters in the user's words, as the windows see them. The backend keeps the words, their rules and the
 * draft (`whatMatters.words*`) and says when any changed (`whatMattersWords`); read only while a view of them is open.
 * Nothing here is stored or sent anywhere else.
 */

/** The words' state, read while mounted and kept by the backend's event; null until the first read. */
export function useWords(): [WhatMattersWordsState | null, (next: WhatMattersWordsState) => void] {
  const [state, setState] = useState<WhatMattersWordsState | null>(null);
  useEffect(() => {
    let current = true;
    void client.call("whatMatters.words", {}).then((s) => current && setState(s), () => {});
    const off = client.on("whatMattersWords", (s) => current && setState(s));
    return () => {
      current = false;
      off();
    };
  }, []);
  return [state, setState];
}

/** A draft's order: later typing always wins over an earlier write still on its way (the backend refuses an older one). */
export const draftSeq = (): number => Date.now();

/** The words kept as typed, never lost (a failed write is retried by the next keystroke). */
export function saveDraft(text: string, seq: number): void {
  void client.call("whatMatters.words.draft", { text, seq }).catch(() => {});
}

const message = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

/**
 * Save: the words compiled and saved against the revision they were typed on. True when saved. Another window's save
 * since says so and the caller shows the saved words; a failure keeps the typed words and says the earlier ones still apply.
 */
export async function saveWords(text: string, revision: number): Promise<{ saved: boolean; stale?: boolean }> {
  try {
    const r = await client.call("whatMatters.words.save", { text, revision });
    if ("stale" in r) {
      snack.error(t("whatMatters.words.stale"));
      return { saved: false, stale: true };
    }
    snack.success(text.trim() ? t("whatMatters.words.saved") : t("whatMatters.words.cleared"));
    return { saved: true };
  } catch (error) {
    snack.error(t("whatMatters.words.failed", { message: message(error) }));
    return { saved: false };
  }
}

/** Clear: no AI, at once, with Undo (the words and their rules back, unless something was saved since). */
export async function clearWords(revision: number): Promise<boolean> {
  try {
    const r = await client.call("whatMatters.words.clear", { revision });
    if ("stale" in r) {
      snack.error(t("whatMatters.words.stale"));
      return false;
    }
    const { undoId } = r;
    const after = r.preferences.revision;
    const undo = undoId ? registerUndo(() => client.call("whatMatters.words.undoClear", { undoId, revision: after }).then((u) => ("stale" in u ? snack.error(t("whatMatters.words.stale")) : undefined))) : null;
    snack.success(t("whatMatters.words.cleared"), undo ? { action: { label: t("common.undo"), undo } } : {});
    return true;
  } catch (error) {
    snack.error(message(error));
    return false;
  }
}
