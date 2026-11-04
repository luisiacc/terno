import { useLayoutEffect, useRef, type RefObject } from "react";
import { controllerFor } from "~/components/composer/controller";
import { pinDraft, unpinDraft } from "~/lib/pinned-draft";
import { pinnedKey } from "~/lib/pinned-draft-state";

/**
 * Plan 88: what the palette can do to a draft, through the composer's own
 * handlers (its focus handoff and snacks) and controls, registered per draft
 * key while its form is mounted.
 */
export interface DraftCommands {
  /** `at`: Send Later, as the form's own Send would */
  send(at?: number): void;
  discard(): void;
  /** plan 133: what Esc does in this form (collapse, leave the new message, step out of the card) */
  close?(): void;
  attach(): void;
  showCc(): void;
  showBcc(): void;
  link(): void;
  /** plan 115: to the reading area's corner, or back */
  pin(): void;
  unpin(): void;
  /** what the palette offers now, read from the form's own controls (disabled while sending, recovering or uploading) */
  state(): DraftCommandState;
}

export interface DraftCommandState {
  send: boolean;
  discard: boolean;
  attach: boolean;
  /** the Cc and Bcc toggles are there (their fields are hidden) */
  addCc: boolean;
  addBcc: boolean;
  link: boolean;
  pin: boolean;
  unpin: boolean;
}

const registry = new Map<string, DraftCommands>();

export function registerDraftCommands(key: string, c: DraftCommands): () => void {
  registry.set(key, c);
  return () => {
    if (registry.get(key) === c) registry.delete(key);
  };
}

export const draftCommands = (key: string | null | undefined): DraftCommands | null => (key ? (registry.get(key) ?? null) : null);

/** The draft whose form holds this element (the focused one, when ⌘K opens the palette). */
export function draftKeyOf(el: Element | null): string | null {
  const form = el?.closest<HTMLElement>("[data-testid=composer][data-draft-key]");
  return form?.dataset.draftKey ?? null;
}

/**
 * A composer's form registers its commands: send and discard are its own
 * handlers (the latest render's); Cc, Bcc and Attach press its own controls,
 * so their reveal, focus and file picker are exactly a click's.
 */
export function DraftCommandsHost({ draftKey: key, root, ...own }: { draftKey: string; root: RefObject<HTMLElement | null>; send(at?: number): void; discard(): void; close?(): void; sending: boolean }): null {
  const latest = useRef(own);
  useLayoutEffect(() => {
    latest.current = own;
  });
  useLayoutEffect(() => {
    const control = (testId: string) => root.current?.querySelector<HTMLElement>(`[data-testid=${testId}]`) ?? null;
    return registerDraftCommands(key, {
      send: (at) => latest.current.send(at),
      discard: () => latest.current.discard(),
      close: () => latest.current.close?.(),
      attach: () => control("attachment-input")?.click(),
      showCc: () => control("compose-show-cc")?.click(),
      showBcc: () => control("compose-show-bcc")?.click(),
      link: () => controllerFor(key)?.openLink(),
      pin: () => pinDraft(key),
      unpin: () => unpinDraft(key),
      state: () => {
        const enabled = (testId: string) => {
          const el = control(testId);
          return el !== null && !(el as HTMLButtonElement).disabled;
        };
        return { send: enabled("compose-send"), discard: enabled("compose-discard"), attach: enabled("attachment-input"), addCc: enabled("compose-show-cc"), addBcc: enabled("compose-show-bcc"), link: !latest.current.sending, pin: !latest.current.sending && pinnedKey() !== key, unpin: pinnedKey() === key };
      },
    });
  }, [key, root]);
  return null;
}
