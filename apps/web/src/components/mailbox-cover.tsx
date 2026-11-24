import type { MailboxGate } from "@terno/core/mailbox";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Spinner } from "@terno/ui/components/spinner";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatBytes } from "~/lib/format";
import { retryMailbox, useMailbox } from "~/lib/mailbox";
import { registerNativeReloadModal } from "~/lib/native-reload";
import { openLink } from "~/lib/open-link";
import { TERNO_LINKS } from "~/lib/terno-links";
import { errorText, unsupportedText, updateNow, useUpdates } from "~/lib/updates";
import { exportDiagnostics } from "~/state/diag";

/**
 * Plan 95: what covers the desktop window while the mailbox can't be used
 * (the gate main pushes), or while this version is below the one the
 * update feed requires. Calm and plain: what happened, what to do, one
 * primary action.
 */
export default function MailboxCover({ required }: { required: boolean }) {
  const gate = useMailbox((s) => s.gate);
  if (gate.kind !== "open") return <GateScreen gate={gate} />;
  return required ? <RequiredScreen /> : null;
}

/** The full-window layer: modal for assistive tech, the primary action focused, native reload held while it shows. */
function Cover({ title, children, testId, kind, busy }: { title: string; children: ReactNode; testId: string; kind: string; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useLayoutEffect(() => {
    const release = registerNativeReloadModal(ref.current!, document.getElementById("root"));
    const primary = ref.current?.querySelector<HTMLElement>("[data-primary]") ?? ref.current;
    primary?.focus();
    return release;
  }, [kind]);
  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      aria-busy={busy || undefined}
      data-testid={testId}
      data-kind={kind}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-10 text-center outline-none backdrop-blur-md"
    >
      <div className="flex max-w-sm flex-col items-center">
        <p id={titleId} className="text-md font-semibold tracking-tight">
          {title}
        </p>
        <DescribedBy.Provider value={bodyId}>{children}</DescribedBy.Provider>
      </div>
    </div>,
    document.body,
  );
}

/** the cover's main sentence is its description for assistive tech (what happened, what to do), not only its title */
const DescribedBy = createContext<string | undefined>(undefined);

const Body = ({ children, testId, describes = true }: { children: ReactNode; testId?: string; describes?: boolean }) => {
  const id = useContext(DescribedBy);
  return (
    <p id={describes ? id : undefined} className="mt-1.5 text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
};

const Actions = ({ children }: { children: ReactNode }) => <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>;

function GateScreen({ gate }: { gate: Exclude<MailboxGate, { kind: "open" }> }) {
  const busy = useMailbox((s) => s.busy);
  const retry = (
    <Button variant="outline" disabled={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
      {t("updates.tryAgain")}
    </Button>
  );
  const exportButton = (
    <Button variant="ghost" onClick={() => void exportDiagnostics()}>
      {t("diag.exportButton")}
    </Button>
  );
  switch (gate.kind) {
    case "upgrading":
      return <Upgrading />;
    case "no-room":
      return (
        <Cover title={t("mailbox.noRoom.title")} testId="mailbox-gate" kind="no-room">
          <Body testId="mailbox-body">{t("mailbox.noRoom.body", { need: formatBytes(gate.needBytes), free: formatBytes(gate.freeBytes) })}</Body>
          <Actions>
            <Button data-primary loading={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
              {t("updates.tryAgain")}
            </Button>
          </Actions>
        </Cover>
      );
    case "newer":
      return (
        <Cover title={t("mailbox.newer.title")} testId="mailbox-gate" kind="newer">
          <Body>{t("mailbox.newer.body")}</Body>
          <UpdateAction label={t("updates.required.action")} />
        </Cover>
      );
    case "failed":
      switch (gate.reason) {
        case "migration":
          return (
            <Cover title={t("mailbox.migration.title")} testId="mailbox-gate" kind="migration">
              <Body>{t("mailbox.migration.body")}</Body>
              <UpdateAction label={t("mailbox.checkForUpdates")} secondary={<>{retry}{exportButton}</>} />
            </Cover>
          );
        case "unwritable":
          return (
            <Cover title={t("mailbox.unwritable.title")} testId="mailbox-gate" kind="unwritable">
              <Body>{t("mailbox.unwritable.body")}</Body>
              <Actions>
                <Button data-primary loading={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
                  {t("updates.tryAgain")}
                </Button>
              </Actions>
            </Cover>
          );
        case "corrupt":
          return (
            <Cover title={t("mailbox.corrupt.title")} testId="mailbox-gate" kind="corrupt">
              <Body>{t("mailbox.corrupt.body")}</Body>
              <Actions>
                <Button data-primary disabled={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
                  {t("updates.tryAgain")}
                </Button>
                {exportButton}
              </Actions>
            </Cover>
          );
      }
  }
}

/** A quick migration never flashes a screen: it shows only after 400 ms. */
function Upgrading() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 400);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <Cover title={t("mailbox.upgrading.title")} testId="mailbox-gate" kind="upgrading" busy>
      <Body testId="mailbox-body">{t("mailbox.upgrading.body")}</Body>
      <Spinner className="mt-4 text-muted-foreground" aria-hidden />
    </Cover>
  );
}

/** Plan 95: this version is below the minimum the feed requires. Drafts are saved before this shows (useRequiredCover). */
function RequiredScreen() {
  const state = useUpdates((s) => s.state);
  if (!state?.required) return null;
  const offered = state.ready ?? state.available;
  return (
    <Cover title={t("updates.required.title")} testId="required-update" kind="required">
      <Body testId="required-body">
        {t("updates.required.body", { current: state.current })} {offered && t("updates.required.ready", { version: offered.version })}
      </Body>
      <UpdateAction label={t("updates.required.action")} />
    </Cover>
  );
}

/**
 * The one button that updates Terno (required, a newer mailbox, a step a fix
 * may solve): what the click does is said beside it; its progress, its
 * outcome and a copy that can't update itself are said in place.
 */
function UpdateAction({ label, secondary = null }: { label: string; secondary?: ReactNode }) {
  const state = useUpdates((s) => s.state);
  const [asked, setAsked] = useState(false);
  const [running, setRunning] = useState(false);
  if (!state) return <Actions>{secondary}</Actions>;
  if (state.status === "unsupported") {
    return (
      <>
        {state.unsupported && <Body describes={false}>{unsupportedText(state.unsupported)}</Body>}
        <Actions>
          <Button data-primary onClick={() => openLink(TERNO_LINKS.latest)} data-testid="update-download-page">
            {t("updates.required.downloadPage")}
          </Button>
          {secondary}
        </Actions>
      </>
    );
  }
  const working = running || state.updatingNow || state.status === "checking" || state.status === "downloading" || state.status === "verifying" || state.status === "installing" || state.deferred === "sending";
  const progress =
    state.deferred === "sending"
      ? t("updates.required.waiting")
      : state.status === "installing"
        ? t("updates.required.installing")
        : state.status === "verifying"
          ? t("updates.required.verifying")
          : state.status === "downloading"
            ? t("updates.required.downloading", { percent: state.percent ?? 0 })
            : state.status === "checking"
              ? t("updates.checking")
              : null;
  const outcome = !working && asked ? (state.error ? errorText(state.error.kind) : state.status === "up-to-date" ? t("updates.required.none") : null) : null;
  return (
    <>
      <p className="mt-3 text-xs text-muted-foreground">{t("updates.required.consent")}</p>
      <Actions>
        <Button
          data-primary
          loading={working}
          data-testid="update-now"
          onClick={() => {
            setAsked(true);
            setRunning(true);
            void updateNow().finally(() => setRunning(false));
          }}
        >
          {outcome && state.error ? t("updates.tryAgain") : label}
        </Button>
        {secondary}
      </Actions>
      <p aria-live="polite" className="mt-3 min-h-4 text-xs text-muted-foreground tabular-nums" data-testid="update-now-status">
        {progress ?? outcome ?? ""}
      </p>
    </>
  );
}
