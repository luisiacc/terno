import { REMOVABLE_BUCKETS, STORAGE_AGES, STORAGE_BUCKETS, type CategoryColor, type StorageAge, type StorageAmount, type StorageBucket, type StorageReport } from "@terno/core";
import { formatList, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Skeleton } from "@terno/ui/components/skeleton";
import { cn } from "@terno/ui/lib/utils";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, viewLabel } from "~/lib/format";
import { snack } from "~/lib/snack";
import { useStorageJob } from "~/lib/storage-job";
import { StorageSection } from "~/lib/web-parts";
import { client } from "~/rpc/connection";
import { ConfirmDialog, SettingsGroup, SettingsRow } from "./parts";

const WEB = import.meta.env.VITE_TARGET === "web";
const device = () => t(WEB ? "storage.device.web" : "storage.device.mac");

/** Each view's color, the same in the bar and its legend (category tokens: never a raw color). */
const COLOR: Record<StorageBucket, CategoryColor> = { inbox: "indigo", archive: "cyan", sent: "emerald", spam: "amber", trash: "rose" };
const BAR: Record<StorageBucket, string> = { inbox: "bg-cat-indigo", archive: "bg-cat-cyan", sent: "bg-cat-emerald", spam: "bg-cat-amber", trash: "bg-cat-rose" };

const AGE_KEYS = { 30: "storage.age.30", 90: "storage.age.90", 180: "storage.age.180", 365: "storage.age.365", 730: "storage.age.730" } as const satisfies Record<StorageAge, string>;
const ageLabel = (days: StorageAge) => t(AGE_KEYS[days]);

const amountText = (a: StorageAmount) => t("storage.removable", { conversations: t("common.conversations", { count: a.threads }), size: formatBytes(a.bytes) });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Settings → Storage (plan 69): what Terno keeps on this device, by the views the user knows, and removing its copy
 * of old conversations (the mail server keeps its own). Read when the tab opens; nothing polls.
 */
export function StorageTab() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const age = useStorageJob((s) => s.age);
  const picked = useStorageJob((s) => s.picked);
  const [confirming, setConfirming] = useState(false);
  const removing = useStorageJob((s) => s.removing);
  const percent = useStorageJob((s) => s.percent);
  const finished = useStorageJob((s) => s.finished);
  /** the latest ask: an older answer that arrives after it is dropped */
  const asked = useRef(0);

  const load = useCallback(async () => {
    const mine = ++asked.current;
    setError(null);
    try {
      const r = await client.call("storage.report", {});
      if (mine === asked.current) setReport(r);
    } catch (e) {
      if (mine === asked.current) setError(errorText(e));
    }
  }, []);
  // on open, and again after every removal (this tab's or one started before it opened)
  useEffect(() => {
    void load();
  }, [load, finished]);

  const ageIndex = STORAGE_AGES.indexOf(age);
  const bucket = (b: StorageBucket) => report?.buckets.find((x) => x.bucket === b);
  const chosen = REMOVABLE_BUCKETS.filter((b) => picked.has(b));
  const selected = chosen.reduce<StorageAmount>(
    (sum, b) => {
      const a = bucket(b)?.removable[ageIndex];
      return a ? { threads: sum.threads + a.threads, messages: sum.messages + a.messages, bytes: sum.bytes + a.bytes } : sum;
    },
    { threads: 0, messages: 0, bytes: 0 },
  );

  const remove = async () => {
    useStorageJob.setState({ removing: true, percent: 0 });
    const jobId = `storage-${Date.now()}`;
    const off = client.on("bulkProgress", (p) => {
      if (p.jobId === jobId && p.total) useStorageJob.setState({ percent: Math.floor((p.done / p.total) * 100) });
    });
    try {
      const r = await client.call("storage.remove", { buckets: chosen, olderThanDays: age, jobId });
      if (!r.threads) snack(t("storage.nothingRemoved"));
      else snack.success([t("storage.done", { count: r.threads, device: device() }), r.compact === "onRestart" ? t("storage.doneLater") : ""].filter(Boolean).join(" "));
    } catch (e) {
      snack.error(errorText(e));
    } finally {
      off();
      // what is there now gets measured again, by whichever Storage tab is open
      useStorageJob.setState((s) => ({ removing: false, percent: 0, finished: s.finished + 1 }));
    }
  };

  return (
    <div data-testid="storage-tab">
      {error ? (
        <SettingsGroup>
          <SettingsRow label={t("storage.error", { message: error })} testId="storage-error">
            {({ id: _id, "aria-labelledby": _l, ...a }) => (
              <Button {...a} variant="outline" size="sm" onClick={() => void load()}>
                {t("storage.retry")}
              </Button>
            )}
          </SettingsRow>
        </SettingsGroup>
      ) : (
        <>
          <Usage report={report} />
          <SettingsGroup title={t("storage.byMailbox")} footer={t("storage.byMailbox.footer")} testId="storage-buckets">
            {STORAGE_BUCKETS.map((b) => {
              const r = bucket(b);
              return (
                <SettingsRow
                  key={b}
                  testId={`storage-bucket-${b}`}
                  label={
                    <span className="flex items-center gap-2">
                      <CategoryDot color={COLOR[b]} />
                      {viewLabel(b)}
                    </span>
                  }
                  hint={r ? t("common.conversations", { count: r.threads }) : <Skeleton className="mt-1 h-3 w-24" />}
                >
                  {() => (r ? <span className="text-sm text-muted-foreground tabular">{t("storage.about", { size: formatBytes(r.bytes) })}</span> : <Skeleton className="h-4 w-16" />)}
                </SettingsRow>
              );
            })}
          </SettingsGroup>

          <SettingsGroup title={t("storage.free")} footer={t("storage.footer", { device: device() })} testId="storage-free">
            <SettingsRow label={t("storage.olderThan")}>
              {({ id: _id, ...a }) => (
                <Select value={String(age)} onValueChange={(v) => useStorageJob.setState({ age: Number(v) as StorageAge })} items={STORAGE_AGES.map((d) => ({ value: String(d), label: ageLabel(d) }))} disabled={removing}>
                  <SelectTrigger {...a} size="sm" className="w-32" data-testid="storage-age">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STORAGE_AGES.map((d) => (
                      <SelectItem key={d} value={String(d)} data-testid={`storage-age-${d}`}>
                        {ageLabel(d)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </SettingsRow>
            {REMOVABLE_BUCKETS.map((b) => {
              const a = bucket(b)?.removable[ageIndex];
              return (
                <SettingsRow key={b} testId={`storage-pick-${b}`} label={viewLabel(b)} hint={!a ? <Skeleton className="mt-1 h-3 w-32" /> : a.threads ? amountText(a) : t("storage.nothingOld")}>
                  {(a11y) => (
                    <Checkbox
                      {...a11y}
                      checked={picked.has(b)}
                      disabled={removing}
                      data-testid={`storage-pick-${b}-box`}
                      onCheckedChange={(on) =>
                        useStorageJob.setState((s) => {
                          const next = new Set(s.picked);
                          if (on) next.add(b);
                          else next.delete(b);
                          return { picked: next };
                        })
                      }
                    />
                  )}
                </SettingsRow>
              );
            })}
            <SettingsRow label={selected.threads ? amountText(selected) : t("storage.choose")} testId="storage-summary">
              {({ id: _id, "aria-labelledby": _l, ...a }) => (
                <Button
                  {...a}
                  variant="destructive"
                  size="sm"
                  className={cn("min-w-24", removing && "tabular")}
                  disabled={removing || !report || !selected.threads}
                  data-testid="storage-remove"
                  onClick={() => setConfirming(true)}
                >
                  {removing ? t("storage.removing", { percent }) : t("storage.remove")}
                </Button>
              )}
            </SettingsRow>
          </SettingsGroup>
        </>
      )}

      {StorageSection && (
        <Suspense>
          <StorageSection />
        </Suspense>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        testId="storage-confirm"
        title={t("storage.confirm.title", { count: selected.threads, device: device() })}
        description={t("storage.confirm.body", { views: formatList(chosen.map(viewLabel)), age: ageLabel(age), size: formatBytes(selected.bytes) })}
        confirm={t("storage.confirm.action")}
        onConfirm={remove}
      />
    </div>
  );
}

/** The measured footprint, and the mail's share of it by view (a picture; its text says the same). */
function Usage({ report }: { report: StorageReport | null }) {
  const total = report?.buckets.reduce((n, b) => n + b.bytes, 0) ?? 0;
  const shown = report?.buckets.filter((b) => b.bytes > 0) ?? [];
  const free = report?.disk?.free ?? 0;
  return (
    <section className="mb-6 px-1" data-testid="storage-usage-summary">
      <div className="flex items-baseline gap-2">
        {report ? (
          <span className="text-xl font-semibold tracking-display tabular" data-testid="storage-total">
            {formatBytes(report.disk?.bytes ?? total)}
          </span>
        ) : (
          <Skeleton className="h-6 w-20" />
        )}
        <span className="text-sm text-muted-foreground">{t("storage.used", { device: device() })}</span>
      </div>
      {report && free > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground" data-testid="storage-reclaim">
          {report.compactPending ? t("storage.compactPending", { size: formatBytes(free) }) : t("storage.reusable", { size: formatBytes(free) })}
        </p>
      )}
      <div
        role="img"
        aria-label={report ? t("storage.bar", { summary: formatList(shown.map((b) => t("storage.barItem", { view: viewLabel(b.bucket), size: formatBytes(b.bytes) }))) }) : undefined}
        className="mt-3 flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
        data-testid="storage-bar"
      >
        {total > 0 &&
          shown.map((b) => (
            <div key={b.bucket} className={cn("h-full first:rounded-l-full last:rounded-r-full", BAR[b.bucket])} style={{ flexGrow: b.bytes, flexBasis: 0, minWidth: 4 }} data-testid={`storage-bar-${b.bucket}`} />
          ))}
      </div>
      {report && !total && <p className="mt-2 text-xs text-muted-foreground">{t("storage.empty", { device: device() })}</p>}
    </section>
  );
}
