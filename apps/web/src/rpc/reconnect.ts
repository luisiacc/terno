import { client } from "./connection";
import { getApp, publishCounts } from "~/state/app";
import { invalidateListConnection, refreshList } from "~/state/list";
import { invalidateThreadConnection, loadThread } from "~/state/threads";

/** Installed once bootstrap has published; replacements refer to the same logical store. */
export function installQueryRecovery(visibility: { covered(): boolean; readerShown(): boolean }): () => void {
  let active = true;
  let countsRevision = 0;
  const offCounts = client.on("counts", (counts) => {
    countsRevision++;
    publishCounts(counts);
  });
  const offAttach = client.onAttach(() => {
    const connection = client.connectionVersion;
    const revision = countsRevision;
    invalidateThreadConnection();
    invalidateListConnection();
    refreshList(visibility.covered());
    const selected = getApp().selectedId;
    if (selected !== null && visibility.readerShown()) void loadThread(selected);
    void client.call("counts.get", {}).then((counts) => {
      if (active && connection === client.connectionVersion && revision === countsRevision) publishCounts(counts);
    }).catch(() => { /* the next event or reattachment can recover counts */ });
  });
  return () => { active = false; offAttach(); offCounts(); };
}
