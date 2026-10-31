import { similarValue, subjectTemplate, type SimilarAction, type SimilarOffer, type SimilarOffers } from "@terno/core";
import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useState } from "react";
import { said } from "~/lib/actions";
import { chainUndo, isLatest, orderOffers, unchain } from "~/lib/offers";
import { applySimilar, scopeLabel, shownCount, visibleOffers } from "~/lib/similar";
import { dismissSnack, growSnack, patchSnack, snack, undoNow, useSnack, zHolds, type Undo } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { snackbarControls } from "./category-snackbar";
import { OfferLine, OnlyLine } from "./offer-lines";
import { SnackClose, SnackPill } from "./snack-dock";

interface Shown {
  action: SimilarAction;
  /** what its Undo takes back, for a screen reader ("Undo archive") */
  undoName: string;
  /** the threads the action itself moved */
  targets: readonly number[];
  offers: SimilarOffers & { automated?: boolean };
  undo: Undo;
  /** plan 86: the menu's "Only this email" runs no default */
  automation?: "none";
}

/**
 * Plan 63: the plain "Archived · Undo" snack grows, in place (same entry, same
 * countdown), the offers for the rest: the same lines and order as the
 * category snackbar (plan 86). Spam marks everything from the sender by
 * default, with "No, only …" last. Nothing worth offering leaves it as it is.
 */
export function showSimilarSnackbar(snackId: string, shown: Shown): void {
  const runsDefault = defaultScope(shown) !== null;
  // undone meanwhile: nothing to grow (a snack replaced or closed isn't grown either)
  if (shown.undo.state !== "ready" || (!runsDefault && visibleOffers(shown.action, shown.offers.offers).length === 0)) return;
  growSnack(snackId, () => <SimilarSnackbar id={snackId} {...shown} />);
}

/** Plan 86: spam's default, everything from the one sender the targets share (spammers change subjects). */
function defaultScope(shown: Shown): SimilarOffer | null {
  if (shown.action !== "spam" || shown.automation === "none") return null;
  return shown.offers.offers.find((o) => o.scope.kind === "sender") ?? null;
}

interface Default {
  status: "running" | "done" | "failed";
  /** the sweep ran but its filter for new mail couldn't be saved */
  filterFailed?: boolean;
  /** how many more the sweep marked */
  more: number;
  takeBack: () => Promise<void>;
  token: Undo;
}

function SimilarSnackbar({ id, action, targets, offers: first, undo, undoName, automation }: Shown & { id: string }) {
  /** counted again once the default or "only" changed what each line would do */
  const [offers, setOffers] = useState(first);
  const live = useSnack((s) => s.current?.id === id);
  const [def, setDef] = useState<Default | null>(null);
  const [busy, setBusy] = useState(false);
  /** "No, only …" ran: the title says so */
  const [onlyDone, setOnlyDone] = useState(false);
  // a failed default may have marked part of the sender: its chain still takes that back (Codex review)
  const token = def ? def.token : undo;
  const z = useSnack((s) => zHolds(s, token));
  const close = () => dismissSnack(id);
  const current = () => useSnack.getState().current?.id === id;
  const name = offers.senderName ?? "";
  const sender = defaultScope({ action, targets, offers: first, undo, undoName, automation });
  const recount = () =>
    void client.call("offers.forAction", { threadIds: [...targets], action }).then(
      (o) => current() && setOffers(o),
      () => undefined,
    );

  // spam: the rest from the sender too, and a filter for their new mail, while this is still the last thing done
  useEffect(() => {
    if (!sender || !isLatest(undo)) return;
    let settle!: (u: { undoId: number | null; filterUndo: number | null }) => void;
    const settled = new Promise<{ undoId: number | null; filterUndo: number | null }>((r) => (settle = r));
    let taken: Promise<void> | null = null;
    const takeBack = () =>
      (taken ??= settled.then(async (u) => {
        if (u.undoId !== null || u.filterUndo !== null) await client.call("similar.undo", { undoId: u.undoId, filterUndo: u.filterUndo });
      }).catch((error: unknown) => {
        taken = null;
        throw error;
      }));
    const chained = chainUndo(takeBack, undo);
    setDef({ status: "running", more: Math.max(0, sender.count - targets.length), takeBack, token: chained });
    patchSnack(id, { message: t("offers.default.spamming", { count: Math.max(sender.count, targets.length), name }) });
    void client.call("similar.apply", { threadIds: [], scope: sender.scope, action: "spam", filterName: t("filters.learnedName.spam", { value: similarValue(sender.scope) }).slice(0, 120) }).then(
      (r) => {
        settle({ undoId: r.undoId, filterUndo: r.filter?.filterUndo ?? null });
        void reloadList({ keepSelection: true });
        setDef((d) => d && { ...d, status: "done", more: r.affected, filterFailed: r.filterFailed });
        recount();
        if (current()) patchSnack(id, { message: t("offers.default.spammed", { count: targets.length + r.affected, name }) }, true);
      },
      (error: unknown) => {
        const undoId = (error as { details?: { undoId?: unknown } }).details?.undoId;
        settle({ undoId: typeof undoId === "number" ? undoId : null, filterUndo: null });
        setDef((d) => d && { ...d, status: "failed" });
        if (current()) patchSnack(id, { message: t("offers.default.spamFailed", { name, error: error instanceof Error ? error.message : String(error) }), tone: "error" }, true);
      },
    );
  }, []);

  // the default's own scope isn't offered again; the rest in one order everywhere
  const lines = orderOffers(visibleOffers(action, offers.offers)).filter((o) => !(def && def.status !== "failed" && o.scope.kind === "sender"));
  const title = def?.status === "running" ? t("offers.default.spamming", { count: targets.length + def.more, name }) : def?.status === "done" ? t("offers.default.spammed", { count: targets.length + def.more, name }) : onlyDone ? t("offers.only.spamDone", { count: targets.length }) : said(action, targets.length);

  const run = (offer: SimilarOffer | undefined) => {
    if (!offer || def?.status === "running" || busy) return;
    close();
    // narrower than the default (the same subject from them): the default comes back first, then this runs alone
    if (def?.status === "done" && offer.scope.kind === "subject") {
      const narrow = (): void =>
        void def.takeBack().then(
          () => {
            unchain(def.token, undo);
            return applySimilar(action, [], offer.scope, { senderName: offers.senderName, original: undo });
          },
          // the sender's mail is still marked: said, with a retry (Codex review); Undo still takes all of it back
          (error: unknown) =>
            void snack.error(t("offers.narrowFailed", { error: error instanceof Error ? error.message : String(error) }), {
              action: { label: t("common.retry"), name: t("offers.narrowRetry"), onClick: narrow },
            }),
        );
      narrow();
      return;
    }
    // the offer takes over the undo: one Undo brings back this, then the default, then the action
    void applySimilar(action, [], offer.scope, { senderName: offers.senderName, original: token.state === "ready" ? token : undefined });
  };
  const doUndo = () => {
    close();
    undoNow(token);
  };
  /** "No, only mark this email as spam": the sweep and its filter come back; the user's own mark stays, z takes that back. */
  const only = () => {
    if (def?.status !== "done" || busy) return;
    setBusy(true);
    def.takeBack().then(
      () => {
        unchain(def.token, undo);
        setDef(null);
        setOnlyDone(true);
        setBusy(false);
        recount();
        void reloadList({ keepSelection: true });
        if (current()) patchSnack(id, { message: t("offers.only.spamDone", { count: targets.length }) }, true);
      },
      (error: unknown) => {
        setBusy(false);
        if (current()) patchSnack(id, { message: t("snack.undoFailed", { error: error instanceof Error ? error.message : String(error) }), tone: "error" }, true);
      },
    );
  };

  useEffect(() => {
    if (!live) return;
    snackbarControls.current = { action: (n) => run(lines[n - 1]), only, undo: doUndo, close };
    setApp({ snackbar: true });
    return () => {
      snackbarControls.current = null;
      setApp({ snackbar: false });
    };
  });

  // said only when a filter now catches their new mail (each line says "+ new mail" for itself)
  const note = def?.status === "done" ? t(def.filterFailed ? "offers.default.noFilter" : "offers.default.spamFuture") : null;
  return (
    <div data-testid="similar-snackbar" data-default={def?.status}>
      <div className="flex min-h-9 items-center gap-2 py-1.5 pr-1.5 pl-3">
        <p className={cn("line-clamp-2 min-w-0 flex-1 text-sm", def && "font-medium")} data-testid="snack-message" title={title}>
          {title}
        </p>
        {token.state === "ready" && <SnackPill testId="snack-action" label={t("common.undo")} name={undoName} shortcut={z ? "z" : undefined} disabled={def?.status === "running" || busy} onClick={doUndo} />}
        <SnackClose onClick={close} />
      </div>
      {note && (
        <p data-testid="similar-future" className="-mt-1.5 truncate pr-3 pb-1 pl-3 text-2xs text-muted-foreground">
          {note}
        </p>
      )}
      <div data-testid="similar-offers" className="flex flex-col px-1.5 pb-1.5">
        {lines.map((o, i) => (
          <OfferLine
            key={o.scope.kind}
            n={i + 1}
            testId={`similar-${o.scope.kind}`}
            label={scopeLabel(o.scope, offers.senderName)}
            detail={o.scope.kind === "subject" ? subjectTemplate(o.scope.subject) : undefined}
            help={t(`offers.help.${action}`, { scope: scopeLabel(o.scope, offers.senderName) })}
            future={action === "spam"}
            disabled={def?.status === "running" || busy}
            count={shownCount(o)}
            onClick={() => run(o)}
          />
        ))}
        {def?.status === "done" && <OnlyLine label={t("offers.only.spam", { count: targets.length })} onClick={only} disabled={busy} />}
      </div>
    </div>
  );
}
