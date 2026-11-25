import { addressKey, type PersonRule } from "@terno/core";
import { useEffect } from "react";
import { create } from "zustand";
import { client } from "~/rpc/connection";

/**
 * Plan 278: your word on who is a person, for every sender's menu and Settings. Read the first time one asks, then kept by the
 * backend's `personRules`, which every window hears; read again on a reconnection, when an event may have been missed.
 * `rules` null: not read yet (a menu's choice waits for it).
 */
export const usePersonRules = create<{ rules: PersonRule[] | null }>(() => ({ rules: null }));

let reading: Promise<void> | null = null;
/** bumped by every event and reconnection: a read answered after one is stale and dropped */
let generation = 0;
/** something has asked: a reconnection reads again even when the first read never answered (Codex code review #4) */
let wanted = false;

/** Once, unless it failed (then the next ask reads again). */
export function readPersonRules(): Promise<void> {
  wanted = true;
  const asked = generation;
  const read: Promise<void> = (reading ??= client.call("people.rules", {}).then(
    ({ rules }) => {
      if (asked === generation) usePersonRules.setState({ rules });
      else if (reading === read) reading = null;
    },
    () => {
      // only this read's slot: a newer one may have taken it
      if (reading === read) reading = null;
    },
  ));
  return read;
}

/** Read again whatever is held (a change that failed may have left a row out of step). */
export function rereadPersonRules(): Promise<void> {
  generation++;
  reading = null;
  return readPersonRules();
}

/** At boot, once there's a connection to listen on. */
export function installPersonRules(): void {
  client.on("personRules", ({ rules }) => {
    generation++;
    usePersonRules.setState({ rules });
  });
  client.onAttach(() => {
    generation++;
    reading = null;
    // read again only if something has asked: no work before a menu or Settings does
    if (wanted) void readPersonRules();
  });
}

/** This address's rule (any spelling of it): undefined while unknown (read on first use), null when it has none. */
export function usePersonRule(email: string): PersonRule | null | undefined {
  const rules = usePersonRules((s) => s.rules);
  useEffect(() => {
    if (rules === null) void readPersonRules();
  }, [rules]);
  if (rules === null) return undefined;
  const key = addressKey(email);
  return rules.find((r) => r.key === key) ?? null;
}
