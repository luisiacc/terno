import type { MailboxGate } from "@terno/core/mailbox";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Spinner } from "@terno/ui/components/spinner";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatBytes } from "~/lib/format";
import { backupDate, restoreMailbox, retryMailbox, skipMailboxBackup, useMailbox } from "~/lib/mailbox";
import { registerNativeReloadModal } from "~/lib/native-reload";
import { openLink } from "~/lib/open-link";
import { TERNO_LINKS } from "~/lib/terno-links";
import { errorText, unsupportedText, updateNow, useUpdates } from "~/lib/updates";
import { exportDiagnostics } from "~/state/diag";
import { ConfirmDialog } from "./settings/parts";

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
      aria-busy={busy || undefined}
      data-testid={testId}
      data-kind={kind}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-10 text-center outline-none backdrop-blur-md"
    >
      <div className="flex max-w-sm flex-col items-center">
        <p id={titleId} className="text-md font-semibold tracking-tight">
          {title}
        </p>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const Body = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className="mt-1.5 text-sm text-muted-foreground" data-testid={testId}>
    {children}
  </p>
);

const Actions = ({ children }: { children: ReactNode }) => <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>;

function GateScreen({ gate }: { gate: Exclude<MailboxGate, { kind: "open" }> }) {
  const busy = useMailbox((s) => s.busy);
  const retry = (
    <Button variant="outline" disabled={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
      {t("updates.tryAgain")}
    </Button>
  );
  const skip = (
    <Button variant="outline" disabled={busy} onClick={() => void skipMailboxBackup()} data-testid="mailbox-skip-backup">
      {t("mailbox.skipBackup")}
    </Button>
  );
  const exportButton = (
    <Button variant="ghost" onClick={() => void exportDiagnostics()}>
      {t("diag.exportButton")}
    </Button>
  );
  switch (gate.kind) {
    case "upgrading":
      return <Upgrading phase={gate.phase} />;
    case "restoring":
      return (
        <Cover title={t("mailbox.restoring")} testId="mailbox-gate" kind="restoring" busy>
          <Spinner className="mt-4 text-muted-foreground" aria-hidden />
        </Cover>
      );
    case "no-room":
      return (
        <Cover title={t("mailbox.noRoom.title")} testId="mailbox-gate" kind="no-room">
          <Body testId="mailbox-body">{t(gate.stage === "backup" ? "mailbox.noRoom.backup" : "mailbox.noRoom.migrate", { need: formatBytes(gate.needBytes), free: formatBytes(gate.freeBytes) })}</Body>
          {gate.canSkipBackup && <Body>{t("mailbox.noRoom.skipHint")}</Body>}
          <Actions>
            <Button data-primary loading={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
              {t("updates.tryAgain")}
            </Button>
            {gate.canSkipBackup && skip}
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
        case "backup":
          return (
            <Cover title={t("mailbox.backup.title")} testId="mailbox-gate" kind="backup">
              <Body>{t("mailbox.backup.body")}</Body>
              <Actions>
                <Button data-primary loading={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
                  {t("updates.tryAgain")}
                </Button>
                {skip}
              </Actions>
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
          return <Corrupt gate={gate} retry={retry} exportButton={exportButton} />;
      }
  }
}

/** A quick upgrade never flashes a screen: it shows only after 400 ms. */
function Upgrading({ phase }: { phase: "backup" | "migrate" }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 400);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <Cover title={t("mailbox.upgrading.title")} testId="mailbox-gate" kind="upgrading" busy>
      <Body testId="mailbox-body">{t(phase === "backup" ? "mailbox.upgrading.backup" : "mailbox.upgrading.migrate")}</Body>
      <Spinner className="mt-4 text-muted-foreground" aria-hidden />
    </Cover>
  );
}

function Corrupt({ gate, retry, exportButton }: { gate: Extract<MailboxGate, { kind: "failed" }>; retry: ReactNode; exportButton: ReactNode }) {
  const busy = useMailbox((s) => s.busy);
  const [confirming, setConfirming] = useState(false);
  const date = gate.backup ? backupDate(gate.backup.createdAt) : "";
  return (
    <Cover title={t("mailbox.corrupt.title")} testId="mailbox-gate" kind="corrupt">
      <Body>{gate.backup ? t("mailbox.corrupt.withBackup", { date }) : t("mailbox.corrupt.noBackup")}</Body>
      {gate.restoreFailed && (
        <p role="alert" className="mt-2 text-sm text-destructive-ink" data-testid="mailbox-restore-failed">
          {t(gate.restoreFailed === "no-room" ? "mailbox.restore.noRoom" : "mailbox.restore.failed")}
        </p>
      )}
      <Actions>
        {gate.backup ? (
          <>
            <Button data-primary disabled={busy} onClick={() => setConfirming(true)} data-testid="mailbox-restore">
              {t("mailbox.restore")}
            </Button>
            {retry}
          </>
        ) : (
          <>
            <Button data-primary disabled={busy} onClick={() => void retryMailbox()} data-testid="mailbox-retry">
              {t("updates.tryAgain")}
            </Button>
            {exportButton}
          </>
        )}
      </Actions>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("mailbox.restore.title", { date })}
        description={t("mailbox.restore.body", { date })}
        confirm={t("mailbox.restore.confirm")}
        onConfirm={() => {
          setConfirming(false);
          void restoreMailbox();
        }}
        testId="mailbox-restore-confirm"
      />
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
        {state.unsupported && <Body>{unsupportedText(state.unsupported)}</Body>}
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
