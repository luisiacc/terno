/**
 * The docked snackbar's store against fake timers: lifetimes, every pause
 * reason, replacement and in-place updates, background news and late job
 * results, and the undo token z and Undo share.
 */
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_MS, clock, DEFAULT_MS, dismissSnack, elapsedAt, pause, registerUndo, remaining, resetSnacks, resume, runAction, runUndo, snack, undoLast, useSnack, zHolds } from "./snack";

const current = () => useSnack.getState().current;
const message = () => current()?.message ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  clock.now = () => Date.now();
  resetSnacks();
});
afterEach(() => {
  vi.useRealTimers();
  setLocale("en", en);
});

describe("lifetime", () => {
  it("goes after 4 s; with an action or as an error after 6 s; an explicit duration wins", () => {
    snack("Archivado");
    vi.advanceTimersByTime(DEFAULT_MS - 1);
    expect(message()).toBe("Archivado");
    vi.advanceTimersByTime(1);
    expect(current()).toBeNull();

    snack("Archivado", { action: { label: "Deshacer", onClick: () => {} } });
    vi.advanceTimersByTime(DEFAULT_MS);
    expect(current()).not.toBeNull();
    vi.advanceTimersByTime(ACTION_MS - DEFAULT_MS);
    expect(current()).toBeNull();

    snack.error("No se pudo completar");
    expect(current()?.duration).toBe(ACTION_MS);
    snack("Copiado", { duration: 2000 });
    expect(current()?.duration).toBe(2000);
  });

  it("a loading snack stays until its id is updated, then its result gets its whole time", () => {
    const id = snack.loading("Archivando…");
    vi.advanceTimersByTime(60_000);
    expect(message()).toBe("Archivando…");
    expect(remaining()).toBe(Infinity);
    snack.success("Archivado · 5 000 conversaciones", { id, duration: 8000 });
    expect(current()?.id).toBe(id);
    vi.advanceTimersByTime(7999);
    expect(current()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(current()).toBeNull();
  });
});

describe("pausing", () => {
  it("each reason holds the countdown; it resumes with what was left", () => {
    for (const reason of ["hover", "focus", "hidden", "blocked", "busy"] as const) {
      snack("Archivado");
      vi.advanceTimersByTime(1000);
      pause(reason);
      vi.advanceTimersByTime(30_000);
      expect(message(), reason).toBe("Archivado");
      expect(remaining()).toBe(DEFAULT_MS - 1000);
      resume(reason);
      vi.advanceTimersByTime(DEFAULT_MS - 1001);
      expect(current(), reason).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(current(), reason).toBeNull();
    }
  });

  it("overlapping reasons: it runs again only when the last one ends", () => {
    snack("Archivado");
    pause("hover");
    pause("focus");
    resume("hover");
    vi.advanceTimersByTime(10_000);
    expect(current()).not.toBeNull();
    resume("focus");
    vi.advanceTimersByTime(DEFAULT_MS);
    expect(current()).toBeNull();
  });

  it("a snack shown while paused starts paused (the pointer is still over the dock)", () => {
    pause("hover");
    snack("Archivado");
    vi.advanceTimersByTime(10_000);
    expect(useSnack.getState().countdown).toEqual({ elapsed: 0, since: null });
    resume("hover");
    vi.advanceTimersByTime(DEFAULT_MS);
    expect(current()).toBeNull();
  });

  it("the elapsed time follows pauses (what the ring draws)", () => {
    snack("Archivado");
    vi.advanceTimersByTime(1500);
    pause("hover");
    vi.advanceTimersByTime(5000);
    expect(elapsedAt(useSnack.getState().countdown, clock.now())).toBe(1500);
    resume("hover");
    vi.advanceTimersByTime(500);
    expect(elapsedAt(useSnack.getState().countdown, clock.now())).toBe(2000);
  });
});

describe("one at a time", () => {
  it("a new snack replaces the current one and starts its own lifetime", () => {
    snack("Archivado");
    vi.advanceTimersByTime(3000);
    const first = current()!.seq;
    snack("Movido a la papelera");
    expect(message()).toBe("Movido a la papelera");
    expect(current()!.seq).toBeGreaterThan(first);
    vi.advanceTimersByTime(DEFAULT_MS - 1);
    expect(current()).not.toBeNull();
  });

  it("the same id updates in place: same entry, nothing re-announced by a progress update", () => {
    const id = snack.loading("Archivando 5 000 conversaciones…");
    const { seq, spoken } = current()!;
    snack.progress(id, "Archivando 5 000 conversaciones… 1 000 / 5 000");
    expect(current()!.seq).toBe(seq);
    expect(current()!.spoken).toBe(spoken);
    expect(message()).toContain("1 000 / 5 000");
  });

  it("progress never takes the dock back from a newer snack; the job's result waits its turn", () => {
    const job = snack.loading("Archivando…");
    snack("Borrador descartado", { action: { label: "Deshacer", onClick: () => {} } });
    snack.progress(job, "Archivando… 10 / 20");
    expect(message()).toBe("Borrador descartado");
    snack.success("Archivado · 20 conversaciones", { id: job });
    expect(message()).toBe("Borrador descartado");
    dismissSnack();
    expect(message()).toBe("Archivado · 20 conversaciones");
  });

  it("background news waits behind the user's own snacks, and behind any news that offers something or is hovered", () => {
    snack("Archivado", { action: { label: "Deshacer", onClick: () => {} } });
    snack.success("Correo enviado", { background: true });
    expect(message()).toBe("Archivado");
    vi.advanceTimersByTime(ACTION_MS);
    expect(message()).toBe("Correo enviado");

    // a plain confirmation of what the user just did is read first (it was replaced 17 ms later by a sync error)
    snack.success("luis@gmail.com conectada");
    snack.error("Falló: star", { background: true });
    expect(message()).toBe("luis@gmail.com conectada");
    vi.advanceTimersByTime(DEFAULT_MS);
    expect(message()).toBe("Falló: star");
    dismissSnack();

    snack.success("Correo enviado", { background: true });
    pause("hover");
    snack("Terno añadió 2 conversaciones a Facturas", { background: true });
    expect(message()).toBe("Correo enviado");
    resume("hover");
    dismissSnack();

    // news replaces plain news; a job's progress doesn't hold against it
    snack.success("Correo enviado", { background: true });
    snack.success("Enviado otra vez", { background: true });
    expect(message()).toBe("Enviado otra vez");
    snack.loading("Archivando…");
    snack.success("Correo enviado", { background: true });
    expect(message()).toBe("Correo enviado");
  });

  it("a queued result whose undo already ran with z is dropped, not offered", async () => {
    const run = vi.fn();
    const undo = registerUndo(run);
    const job = snack.loading("Archivando…");
    snack("Borrador descartado", { action: { label: "Undo", onClick: () => {} } });
    snack.success("Archivado · 20 conversaciones", { id: job, action: { label: "Undo", undo } });
    undoLast();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
    dismissSnack();
    expect(current()).toBeNull();
  });

  it("the queue keeps the newest three", () => {
    snack.error("No se pudo completar");
    for (const n of [1, 2, 3, 4]) snack(`Aviso ${n}`, { background: true });
    dismissSnack();
    expect(message()).toBe("Aviso 2");
  });

  it("an action closes its snack before running, so what it shows stays", () => {
    snack("Filtro creado", { action: { label: "Editar", onClick: () => snack("Abriendo filtros") } });
    runAction("action");
    expect(message()).toBe("Abriendo filtros");
  });

  it("dismissing by id leaves a newer snack alone", () => {
    const old = snack("Archivado");
    snack("Destacado");
    dismissSnack(old);
    expect(message()).toBe("Destacado");
  });
});

describe("the undo token", () => {
  it("z and the button run it once; the snack offering it goes with it", async () => {
    const run = vi.fn();
    const undo = registerUndo(run);
    snack("Borrador descartado", { action: { label: "Deshacer", undo } });
    expect(zHolds(useSnack.getState(), undo)).toBe(true);
    undoLast();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
    expect(current()).toBeNull();
    // the button of a snack still showing it (or a second z) does nothing
    await runUndo(undo);
    undoLast();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the keycap holds only while z would run that same undo", () => {
    const first = registerUndo(() => {});
    snack("Archivado", { action: { label: "Deshacer", undo: first } });
    registerUndo(() => {});
    expect(zHolds(useSnack.getState(), first)).toBe(false);
  });

  it("the button runs it too, and z no longer points at it", async () => {
    const run = vi.fn();
    const undo = registerUndo(run);
    snack("Archivado", { action: { label: "Deshacer", undo } });
    runAction("action");
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
    expect(useSnack.getState().undo).toBeNull();
  });

  it("a failure makes it ready again (for a retry) and rethrows", async () => {
    let fail = true;
    const undo = registerUndo(() => (fail ? Promise.reject(new Error("sin conexión")) : undefined));
    await expect(runUndo(undo)).rejects.toThrow("sin conexión");
    expect(undo.state).toBe("ready");
    fail = false;
    await runUndo(undo);
    expect(undo.state).toBe("done");
  });

  it("a failed Undo click says so with a Retry of the same undo, and z points back at it", async () => {
    let fail = true;
    const run = vi.fn(() => (fail ? Promise.reject(new Error("sin conexión")) : undefined));
    const undo = registerUndo(run);
    snack("Archivado", { action: { label: "Undo", undo } });
    runAction("action");
    await vi.advanceTimersByTimeAsync(0);
    expect(current()?.tone).toBe("error");
    expect(message()).toBe("Couldn’t undo: sin conexión");
    expect(current()?.action).toMatchObject({ label: "Retry", name: "Retry undo" });
    expect(current()?.action?.undo).toBe(undo);
    expect(useSnack.getState().undo).toBe(undo);
    fail = false;
    runAction("action");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(undo.state).toBe("done");
    expect(useSnack.getState().undo).toBeNull();
  });

  it("says the failure in the active language", async () => {
    setLocale("es", es);
    const undo = registerUndo(() => Promise.reject(new Error("sin conexión")));
    snack("Archivado", { action: { label: "Deshacer", undo } });
    runAction("action");
    await vi.advanceTimersByTimeAsync(0);
    expect(message()).toBe("No se pudo deshacer: sin conexión");
    expect(current()?.action).toMatchObject({ label: "Reintentar", name: "Reintentar deshacer" });
  });

  it("a failed undo doesn't take z back from a newer one", async () => {
    const undo = registerUndo(() => Promise.reject(new Error("sin conexión")));
    const pending = runUndo(undo);
    const newer = registerUndo(() => {});
    await expect(pending).rejects.toThrow();
    expect(useSnack.getState().undo).toBe(newer);
  });

  it("expiring or replacing its snack keeps z", () => {
    const undo = registerUndo(() => {});
    snack("Archivado", { action: { label: "Deshacer", undo } });
    vi.advanceTimersByTime(ACTION_MS);
    expect(current()).toBeNull();
    expect(useSnack.getState().undo).toBe(undo);
  });
});
