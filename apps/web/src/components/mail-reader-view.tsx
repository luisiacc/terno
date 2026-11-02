import { registerMailReaderBack } from "./mail-reader-back";
import { t } from "@terno/i18n";
import { Component, createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getApp } from "~/state/app";
import { cancelReaderScroll } from "~/lib/reader-scroll";
import { forwardPrintKey } from "~/lib/print-open";

interface Opening { ticket: { valid: boolean }; lease: object; owner: unknown; focusRequest: number | null; trigger: HTMLElement; fallback: HTMLElement | null; scroller: HTMLElement | null; top: number; y: number }
interface ReaderView { threadId: number | null; active: object | null; target: HTMLDivElement | null; focus(element: HTMLElement | null): void; open(lease: object, trigger: HTMLElement): void; close(lease: object, restore?: boolean): void }
const Context = createContext<ReaderView | null>(null);
export const useMailReaderView = () => useContext(Context);

export function MailReaderView({ identity, focusRequest = null, children }: { identity: unknown; focusRequest?: number | null; children: ReactNode }) {
  const [opening, setOpening] = useState<Opening | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const source = useRef<HTMLDivElement>(null);
  const returning = useRef<Opening | null>(null);
  const escape = useRef<((event: KeyboardEvent) => void) | null>(null);
  const superseded = Boolean(opening && focusRequest !== null && opening.focusRequest !== focusRequest);
  const active = !superseded && opening?.owner === identity ? opening : null;
  const close = useCallback((lease: object, restore = true) => {
    setOpening((current) => {
      if (current?.lease !== lease) return current;
      if (restore && current.ticket.valid && (document.activeElement === document.body || target?.contains(document.activeElement))) returning.current = current;
      return null;
    });
  }, [target]);
  const open = (lease: object, trigger: HTMLElement) => {
    cancelReaderScroll();
    const scroller = trigger.closest<HTMLElement>("[data-reader-scroller]");
    setOpening({ ticket: { valid: true }, lease, owner: identity, focusRequest, trigger, fallback: trigger.parentElement?.querySelector("iframe") ?? null, scroller, top: scroller?.scrollTop ?? 0, y: trigger.getBoundingClientRect().top });
  };
  useLayoutEffect(() => {
    if (superseded) { returning.current = null; setOpening(null); }
  }, [superseded]);
  useLayoutEffect(() => {
    if (active || !returning.current) return;
    const previous = returning.current;
    returning.current = null;
    if (previous.owner !== identity || !previous.ticket.valid || (document.activeElement !== document.body && !target?.contains(document.activeElement))) return;
    const owned = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.isConnected && source.current?.contains(element) && !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }));
    if (owned(previous.trigger)) {
      if (previous.scroller) {
        previous.scroller.scrollTop = previous.top;
        previous.scroller.scrollTop += previous.trigger.getBoundingClientRect().top - previous.y;
      }
      previous.trigger.focus({ preventScroll: true });
    } else if (owned(previous.fallback)) {
      previous.fallback.scrollIntoView({ block: "nearest" });
      previous.fallback.focus({ preventScroll: true });
    }
  }, [active, identity, target]);
  useLayoutEffect(() => {
    if (!active) return;
    const retained = new WeakSet<KeyboardEvent>();
    const intent = (event: Event) => {
      const element = event.target as Element | null;
      const state = getApp();
      if (state.menuOpen || state.dialog !== null || element?.closest?.('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      if (element !== active.trigger && element !== document.body && element !== document.documentElement && !target?.contains(element)) active.ticket.valid = false;
      if (event.type === "pointerdown" && !target?.contains(element)) active.ticket.valid = false;
    };
    window.addEventListener("focusin", intent, true);
    window.addEventListener("pointerdown", intent, true);
    const capture = (event: KeyboardEvent) => {
      const state = getApp();
      if (state.menuOpen || state.dialog !== null || (event.target as Element | null)?.closest?.('[role="menu"], [role="dialog"], [role="alertdialog"]')) retained.add(event);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (retained.has(event)) { event.stopPropagation(); return; }
      if (document.activeElement !== document.body && !target?.contains(document.activeElement)) return;
      forwardPrintKey(event);
      if (event.defaultPrevented) return;
      event.preventDefault(); event.stopImmediatePropagation();
      close(active.lease);
    };
    const unregisterBack = registerMailReaderBack(() => close(active.lease));
    window.addEventListener("keydown", capture, true);
    escape.current = keys;
    const observer = new MutationObserver(() => {
      if (!active.trigger.isConnected || active.trigger.closest('[data-state="closed"]')) close(active.lease, false);
    });
    if (source.current) observer.observe(source.current, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    return () => { window.removeEventListener("focusin", intent, true); window.removeEventListener("pointerdown", intent, true); unregisterBack(); window.removeEventListener("keydown", capture, true); if (escape.current === keys) escape.current = null; observer.disconnect(); };
  }, [active, close, target]);
  return (
    <Context.Provider value={{ threadId: typeof identity === "number" ? identity : null, active: active?.lease ?? null, target, open, close, focus: (element) => { if (active?.ticket.valid && (document.activeElement === document.body || document.activeElement === active.trigger || target?.contains(document.activeElement))) element?.focus({ preventScroll: true }); } }}>
      <div className="relative h-full min-h-0" onKeyDown={(event) => escape.current?.(event.nativeEvent)}>
        <div ref={source} inert={Boolean(active)} aria-hidden={active ? true : undefined} className="h-full min-h-0" style={{ visibility: active ? "hidden" : undefined }}>{children}</div>
        <div ref={setTarget} className={active ? "absolute inset-0 flex min-h-0 flex-col bg-background" : "hidden"} data-full-message-host />
      </div>
    </Context.Provider>
  );
}

export function MailReaderStatus({ onClose, failed = false }: { onClose(): void; failed?: boolean }) {
  const back = useRef<HTMLButtonElement>(null);
  const view = useMailReaderView();
  useLayoutEffect(() => { view?.focus(back.current); }, []);
  return <section className="flex h-full flex-col p-3.5"><button ref={back} type="button" className="self-start rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2" onClick={onClose}>{t("reader.full.back")}</button><p role={failed ? "alert" : "status"}>{t(failed ? "reader.full.error" : "reader.full.loading")}</p></section>;
}

export class FullMessageBoundary extends Component<{ onClose(): void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    return this.state.failed ? <MailReaderStatus onClose={this.props.onClose} failed /> : this.props.children;
  }
}
