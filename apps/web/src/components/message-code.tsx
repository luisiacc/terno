import { codeExpiry, codeFresh, findCode, type MessageDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { mailText } from "~/lib/mail-text";
import { snack } from "~/lib/snack";

/** How long the check shows after a copy. */
export const COPIED_MS = 5000;
const USED_MAX = 200;
/** Messages whose code was copied this session, oldest first: their chip comes back outlined. */
const used = new Set<number>();
const listeners = new Set<() => void>();

function remember(id: number): void {
  used.delete(id);
  used.add(id);
  if (used.size > USED_MAX) used.delete(used.values().next().value!);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Tests: forget what was copied. */
export function resetCopiedCodes(): void {
  used.clear();
}

/**
 * The verification code a received message carries, as a chip that copies it (plan 69). Only for mail at most two
 * hours old: older mail costs one subtraction. Mounted with the open body only, so folded messages do nothing.
 */
export function MessageCode({ m }: { m: MessageDetail }) {
  const [now, setNow] = useState(Date.now);
  const fresh = !m.isSent && codeFresh(m.date, now);
  // the body the reader shows: its HTML when there is one
  const code = useMemo(() => (fresh ? findCode(m.subject, m.bodyHtml ? mailText(m.bodyHtml) : m.bodyText) : null), [fresh, m.subject, m.bodyText, m.bodyHtml]);
  const chip = useRef<HTMLButtonElement>(null);
  // one timer, to the exact expiry; a focused chip waits for the user to move on, so focus is never dropped
  useEffect(() => {
    if (!code) return;
    const expire = () => {
      const el = chip.current;
      if (el && el === document.activeElement) el.addEventListener("blur", () => setNow(Date.now()), { once: true });
      else setNow(Date.now());
    };
    const id = setTimeout(expire, Math.max(0, codeExpiry(m.date) - Date.now()) + 1);
    return () => clearTimeout(id);
  }, [code, m.date]);
  if (!code) return null;
  return (
    <div className="mb-3.5 flex">
      <CodeChip key={code} ref={chip} id={m.id} code={code} />
    </div>
  );
}

function CodeChip({ id, code, ref }: { id: number; code: string; ref: React.Ref<HTMLButtonElement> }) {
  const [copied, setCopied] = useState(false);
  // remembered when the check goes (or when the chip goes first): this chip, or the one shown again later, turns outlined
  const usedOnce = useSyncExternalStore(subscribe, () => used.has(id));
  const [said, setSaid] = useState("");
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the clipboard answers later: a chip gone by then (folded, another thread) only remembers the copy
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (hold.current !== undefined) {
        clearTimeout(hold.current);
        remember(id);
      }
    };
  }, [id]);
  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        if (!alive.current) return remember(id);
        clearTimeout(hold.current);
        setCopied(true);
        setSaid(t("codes.copied"));
        hold.current = setTimeout(() => {
          hold.current = undefined;
          setCopied(false);
          setSaid("");
          remember(id);
        }, COPIED_MS);
      },
      () => {
        if (alive.current) snack.error(t("threadMenu.copyFailed"));
      },
    );
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-testid="message-code"
        data-copied={copied || undefined}
        data-used={usedOnce || undefined}
        aria-label={t("codes.copy", { code })}
        onClick={copy}
        className={cn(
          "group/code inline-flex h-7 items-center gap-1.5 rounded-full border pr-2 pl-2.5 text-sm font-medium tracking-wide tabular outline-none",
          "transition-[background-color,border-color,color] duration-slow ease-motion focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
          "data-used:border-border data-used:bg-transparent data-used:text-foreground data-used:hover:bg-tint",
        )}
      >
        {code}
        {/* the copy icon turns into a check: both stay mounted, one fades and grows as the other shrinks away */}
        <span aria-hidden className="relative size-3.5 shrink-0">
          <Copy className="absolute inset-0 size-3.5 transition-[opacity,scale] duration-base ease-spring group-data-copied/code:scale-50 group-data-copied/code:opacity-0" />
          <Check strokeWidth={2.75} className="absolute inset-0 size-3.5 scale-50 opacity-0 transition-[opacity,scale] duration-base ease-spring group-data-copied/code:scale-100 group-data-copied/code:opacity-100" />
        </span>
      </button>
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </>
  );
}
