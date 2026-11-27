import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { Input } from "@terno/ui/components/input";
import { Label } from "@terno/ui/components/label";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { SocialButton } from "@terno/ui/components/social-button";
import { ArrowLeft, Mail } from "@terno/ui/icons";
import { unhandled, type SignInMethod } from "@terno/core";
import { t } from "@terno/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@terno/ui/lib/utils";
import { hideFocusRing } from "~/lib/focus-ring";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { DesktopOnly } from "~/lib/web-parts";
import { attemptError, type Attempt } from "~/lib/sign-in";
import { windowChoices, windowLabel } from "~/lib/settings-values";

const WEB = import.meta.env.VITE_TARGET === "web";

/** a port fits five digits: it never shrinks beside its host, and has no spinner to cover them */
/** a port: five digits beside the host, no steppers (nobody steps to a port); the arrow keys still do */
const PORT = { className: "w-16 shrink-0", inputClassName: "px-1.5 text-center", steppers: false, min: 1, max: 65535, format: { useGrouping: false } } as const;

/**
 * Known IMAP/SMTP settings so most people only type email + password. Outlook.com's addresses have none (plan 259):
 * its IMAP no longer takes a password, so the form points them to Continue with Microsoft instead.
 */
const PRESETS: Record<string, { imap: string; smtp: string; smtpPort: number }> = {
  "icloud.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587 },
  "me.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587 },
  "fastmail.com": { imap: "imap.fastmail.com", smtp: "smtp.fastmail.com", smtpPort: 465 },
  "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", smtpPort: 465 },
  "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com", smtpPort: 465 },
  "proton.me": { imap: "127.0.0.1", smtp: "127.0.0.1", smtpPort: 1025 },
};

/**
 * Outlook.com's own domains and their best-known country versions, listed (a pattern like `live.xx` would claim
 * unrelated domains such as live.fm, Codex review of plan 259 stage 3 #5). One missing only loses the hint.
 */
const MICROSOFT_DOMAINS = new Set([
  "outlook.com", "outlook.es", "outlook.fr", "outlook.de", "outlook.it", "outlook.jp", "outlook.com.ar", "outlook.com.au", "outlook.com.br",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "hotmail.com.ar", "hotmail.com.br",
  "live.com", "live.co.uk", "live.fr", "live.de", "live.it", "live.nl", "live.ca", "live.com.mx", "live.com.ar", "live.com.au",
  "msn.com", "windowslive.com",
]);

/** plan 259: an address that connects with Microsoft, not IMAP: its domain, else null */
export function microsoftDomain(email: string): string | null {
  const domain = email.trim().split("@")[1]?.toLowerCase() ?? "";
  return MICROSOFT_DOMAINS.has(domain) ? domain : null;
}

/** the ways in that sign in in the browser: Google, and on the desktop Microsoft (plan 259: the web's waits for its stage 4) */
type BrowserMethod = Exclude<SignInMethod, "password">;
const BROWSER_METHODS: readonly BrowserMethod[] = WEB ? ["google"] : ["google", "microsoft"];

function browserButton(method: BrowserMethod) {
  switch (method) {
  case "google": return { label: t("account.continueGoogle"), testId: "connect-gmail" };
  case "microsoft": return { label: t("account.continueMicrosoft"), testId: "connect-microsoft" };
  default: return unhandled(method);
  }
}

/** What the add-account form holds: kept by its host, so the first-run setup keeps it across Back (memory only, never stored). */
export interface AccountDraft {
  /** null: not chosen yet, the default sync window (read when the host has it) */
  picked: number | null;
  /** plan 276: the ways in, or the IMAP form (the first run comes back to the step it left) */
  way: "choose" | "imap";
  form: { email: string; name: string; password: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; user: string };
}

export const EMPTY_ACCOUNT_DRAFT: AccountDraft = { picked: null, way: "choose", form: { email: "", name: "", password: "", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465, user: "" } };

export function AddAccountDialog() {
  const open = useApp((s) => s.dialog === "addAccount");
  const [draft, setDraft] = useState(EMPTY_ACCOUNT_DRAFT);
  // a sign-in finishing after this dialog went (closed while the browser's page was open, another Add account opened
  // since) closes nothing (Codex review of plan 259 stage 3 #1)
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent movable="add-account" className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" data-testid="add-account-dialog">
        <DialogHeader>
          <DialogTitle>{t("account.addTitle")}</DialogTitle>
          <DialogDescription>{t("account.addDescription")}</DialogDescription>
        </DialogHeader>
        <AddAccountForm draft={draft} onDraft={setDraft} onDone={() => alive.current && setApp({ dialog: null })} />
      </DialogContent>
    </Dialog>
  );
}

interface FormProps {
  draft: AccountDraft;
  onDraft: (update: (d: AccountDraft) => AccountDraft) => void;
  /** connected: the host closes, or (gone meanwhile) keeps its books: the first run is finished all the same */
  onDone: () => void;
  /** a connection is in flight (the setup holds Back and Skip meanwhile) */
  onBusy?: (busy: boolean) => void;
}

/**
 * The sync window, then the ways in (Google, Microsoft, Other mail account), or the IMAP form once Other mail account is
 * chosen (plan 276): the add-account dialog's body, and the first-run setup's last step (plan 98).
 */
export function AddAccountForm({ draft, onDraft, onDone, onBusy }: FormProps) {
  const imapHere = useApp((s) => s.host?.capabilities.imap ?? true);
  const generalWindow = useApp((s) => s.settings?.syncWindowDays ?? 180);
  const syncWindowDays = draft.picked ?? generalWindow;
  const form = draft.form;
  const way = draft.way;
  // one connection at a time, whichever way; its progress and failure show where it was started (Microsoft also from the
  // IMAP form's hint, Codex review of plan 259 stage 3 #3)
  const [busy, setBusyState] = useState<SignInMethod | null>(null);
  const [from, setFrom] = useState<"buttons" | "hint">("buttons");
  /** the Outlook.com domain whose hint started a Microsoft sign-in: the hint stays until it settles (plan 276) */
  const [hintFor, setHintFor] = useState<string | null>(null);
  const [error, setError] = useState<{ method: SignInMethod; text: NonNullable<Attempt["error"]> } | null>(null);
  /** moved between the steps since mounting: only then does a step come in moving, and take focus (plan 276) */
  const [moved, setMoved] = useState(false);
  const hintId = useId();
  const emailField = useRef<HTMLInputElement>(null);
  const imapButton = useRef<HTMLButtonElement>(null);
  const hintButton = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<AccountDraft["form"]>) => onDraft((d) => ({ ...d, form: { ...d.form, ...patch } }));
  const setPicked = (picked: number) => onDraft((d) => ({ ...d, picked }));
  const setBusy = (b: SignInMethod | null) => {
    setBusyState(b);
    onBusy?.(b !== null);
  };
  const go = (next: AccountDraft["way"]) => {
    setMoved(true);
    setError(null);
    onDraft((d) => ({ ...d, way: next }));
  };

  // a step chosen here takes focus: the caret in Email, or back on Other mail account (no ring: the app moved it, plan 54)
  useEffect(() => {
    if (!moved) return;
    if (way === "imap") emailField.current?.focus();
    else {
      hideFocusRing();
      imapButton.current?.focus();
    }
  }, [way, moved]);

  const onEmail = (email: string) => {
    const preset = PRESETS[email.split("@")[1]?.toLowerCase() ?? ""];
    const domain = email.split("@")[1] ?? "";
    set({ email, user: email, imapHost: preset?.imap ?? (domain ? `imap.${domain}` : ""), smtpHost: preset?.smtp ?? (domain ? `smtp.${domain}` : ""), smtpPort: preset?.smtpPort ?? 465 });
  };

  // the web signs in with Google's popup, which needs the click's activation: have the script ready before it
  useEffect(() => {
    if (WEB) void import("~/web/google").then((g) => g.preloadGoogle()).catch(() => {});
  }, []);

  const connect = async (method: BrowserMethod) => {
    switch (method) {
    case "google": return WEB ? (await import("~/web/google")).connectGmailWeb(undefined, undefined, { syncWindowDays }) : client.call("accounts.connectGmail", { syncWindowDays });
    case "microsoft": return client.call("accounts.connectMicrosoft", { syncWindowDays });
    default: return unhandled(method);
    }
  };

  // plan 259: an Outlook.com address typed here connects with Microsoft (where this build has it)
  const outlook = BROWSER_METHODS.includes("microsoft") ? microsoftDomain(form.email) : null;

  const connectWith = async (method: BrowserMethod, place: "buttons" | "hint" = "buttons") => {
    setBusy(method);
    setFrom(place);
    setHintFor(place === "hint" ? outlook : null);
    setError(null);
    try {
      const a = await connect(method);
      snack.success(t("account.connected", { email: a.email }));
      onDone();
    } catch (error) {
      setError({ method, text: attemptError(error)! });
    } finally {
      // the hint goes once it settles if the address was edited away meanwhile: focus on its button goes back to Email
      if (place === "hint" && document.activeElement === hintButton.current && !microsoftDomain(emailField.current?.value ?? "")) emailField.current?.focus();
      setBusy(null);
      setHintFor(null);
    }
  };

  const addImap = async () => {
    setBusy("password");
    setError(null);
    try {
      const a = await client.call("accounts.addImap", {
        email: form.email.trim(),
        displayName: form.name.trim() || form.email.trim(),
        password: form.password,
        imap: { host: form.imapHost.trim(), port: form.imapPort, secure: form.imapPort === 993, user: form.user.trim() },
        smtp: { host: form.smtpHost.trim(), port: form.smtpPort, secure: form.smtpPort === 465, user: form.user.trim() },
        syncWindowDays,
      });
      snack.success(t("account.connectedSyncing", { email: a.email }));
      onDone();
    } catch (error) {
      setError({ method: "password", text: attemptError(error)! });
    } finally {
      setBusy(null);
    }
  };

  const failure = error && (
    <div role="alert" className="text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="add-account-error">
      <p className="text-destructive-ink">{error.text.message}</p>
      {error.text.detail && <p className="text-muted-foreground">{error.text.detail}</p>}
    </div>
  );

  // where the host can't do IMAP (the web without it), the Mac download says where it can
  const imapShown = imapHere || !DesktopOnly;
  // a sign-in the hint started keeps the hint (and its spinner) even if the address was edited away meanwhile
  const hint = (busy === "microsoft" && from === "hint" && hintFor) || outlook;

  const choose = (
    <>
      {/* stacked: side by side, "Continue with Microsoft" overflows the first-run's column and longer translations */}
      <div className="flex flex-col gap-2">
        {BROWSER_METHODS.map((method) => {
          const b = browserButton(method);
          return (
            <SocialButton key={method} brand={method} onClick={() => void connectWith(method)} focusableWhenDisabled disabled={busy !== null} loading={busy === method && from === "buttons"} data-testid={b.testId}>
              {b.label}
            </SocialButton>
          );
        })}
        {imapShown && (
          <Button ref={imapButton} variant="outline" size="lg" className="w-full" onClick={() => go("imap")} focusableWhenDisabled disabled={busy !== null} data-testid="connect-imap">
            <Mail /> {t("account.otherMail")} <span className="font-normal text-muted-foreground">{t("account.otherMailKind")}</span>
          </Button>
        )}
      </div>
      {error && error.method !== "password" && from === "buttons" && failure}
      {!imapShown && DesktopOnly && <DesktopOnly feature="imap" />}
    </>
  );

  const imap = (
    <>
      <Button variant="link-secondary" className="justify-self-start" onClick={() => go("choose")} focusableWhenDisabled disabled={busy !== null} data-testid="imap-back">
        <ArrowLeft /> {t("account.chooseAnother")}
      </Button>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy === null) void addImap();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1">
            <Label htmlFor="acc-email">{t("account.email")}</Label>
            <Input ref={emailField} id="acc-email" data-testid="imap-email" type="email" required value={form.email} onChange={(e) => onEmail(e.target.value)} placeholder={t("account.email.placeholder")} aria-describedby={hint ? hintId : undefined} />
            {hint && (
              <p id={hintId} className="text-xs leading-relaxed text-muted-foreground" data-testid="imap-microsoft-hint">
                {t("account.imapMicrosoft", { domain: hint })}{" "}
                <Button ref={hintButton} variant="link" className="text-xs" focusableWhenDisabled disabled={busy !== null} loading={busy === "microsoft" && from === "hint"} onClick={() => void connectWith("microsoft", "hint")} data-testid="imap-microsoft-connect">
                  {t("account.continueMicrosoft")}
                </Button>
              </p>
            )}
            {/* under the address even once it's edited away from Outlook.com (Codex review round 2 #2) */}
            {error?.method === "microsoft" && from === "hint" && failure}
          </div>
          <div className="space-y-1">
            <Label htmlFor="acc-name">{t("account.yourName")}</Label>
            <Input id="acc-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="acc-pass">{t("account.appPassword")}</Label>
            <Input id="acc-pass" data-testid="imap-password" type="password" required value={form.password} onChange={(e) => set({ password: e.target.value })} />
          </div>
          <div className="col-span-2 space-y-1">
            <Label htmlFor="acc-imap">{t("account.imapServer")}</Label>
            <div className="flex gap-1.5">
              <Input id="acc-imap" data-testid="imap-host" required value={form.imapHost} onChange={(e) => set({ imapHost: e.target.value })} />
              <NumberField aria-label={t("account.imapPort")} {...PORT} value={form.imapPort} onValueChange={(port) => set({ imapPort: port ?? 0 })} />
            </div>
          </div>
          <div className="col-span-2 space-y-1">
            <Label htmlFor="acc-smtp">{t("account.smtpServer")}</Label>
            <div className="flex gap-1.5">
              <Input id="acc-smtp" data-testid="smtp-host" required value={form.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} />
              <NumberField aria-label={t("account.smtpPort")} {...PORT} value={form.smtpPort} onValueChange={(port) => set({ smtpPort: port ?? 0 })} />
            </div>
          </div>
        </div>
        <Button type="submit" className="w-full" focusableWhenDisabled disabled={busy !== null} loading={busy === "password"} data-testid="imap-submit">
          {t("account.connectAccount")}
        </Button>
        {error?.method === "password" && failure}
      </form>
    </>
  );

  return (
    <>
      {/* asked once, for whichever way the account connects; it stays put while the steps change under it */}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="acc-window">{t("account.window.label")}</Label>
        <Select value={String(syncWindowDays)} onValueChange={(v) => setPicked(Number(v))} items={windowChoices(generalWindow).map((d) => ({ value: String(d), label: windowLabel(d) }))} disabled={busy !== null}>
          <SelectTrigger id="acc-window" size="sm" className="min-w-40" data-testid="sync-window-choice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {windowChoices(generalWindow).map((d) => (
              <SelectItem key={d} value={String(d)} data-testid={`sync-window-${d}`}>
                {windowLabel(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* keyed by step: chosen here, the new one comes in as the first run's steps do (one --motion-base fade and a 6 px
          slide from the side it came from, nothing fading out); opened or restored, it's simply there */}
      <div
        key={way}
        data-way={way}
        data-testid="add-account-way"
        className={cn("grid gap-4", moved && "animate-in fade-in-0 duration-base ease-motion", moved && (way === "imap" ? "slide-in-from-right-1.5" : "slide-in-from-left-1.5"))}
      >
        {way === "imap" && imapShown ? imap : choose}
      </div>
    </>
  );
}
