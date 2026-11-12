/**
 * The docked snackbar's store against fake timers: lifetimes, every pause
 * reason, replacement and in-place updates, background news and late job
 * results, and the undo token z and Undo share.
 */
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_MS, clock, DEFAULT_MS, dismissSnack, elapsedAt, pause, registerUndo, remaining, resetSnacks, resume, runAction, runUndo, snack, staleOnMove, undoLast, useSnack, zHolds } from "./snack";

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

  it("a snack shown while paused starts paused (focus is still in the dock)", () => {
    pause("focus");
    snack("Archivado");
    vi.advanceTimersByTime(10_000);
    expect(useSnack.getState().countdown).toEqual({ elapsed: 0, since: null });
    resume("focus");
    vi.advanceTimersByTime(DEFAULT_MS);
    expect(current()).toBeNull();
  });

  it("plan 158: a hover held the snack it was over, not the next (Undo's answer under a resting pointer runs out)", () => {
    snack("Archivado", { action: { label: "Deshacer", onClick: () => {} } });
    pause("hover");
    snack("Restaurado");
    expect(useSnack.getState().paused).not.toContain("hover");
    vi.advanceTimersByTime(DEFAULT_MS);
    expect(current()).toBeNull();
    // an update in place is the same snack: the hover still holds it
    snack({ id: "job", message: "Uno", tone: "loading", duration: 1000 });
    pause("hover");
    snack({ id: "job", message: "Dos", tone: "success" });
    vi.advanceTimersByTime(10_000);
    expect(current()?.message).toBe("Dos");
  });

  it("plan 158: only a plain confirmation goes stale when the list changes", () => {
    const shown = (input: Parameters<typeof snack>[0]) => (snack(input), current()!);
    expect(staleOnMove(shown({ message: "Restaurado", tone: "success" }))).toBe(true);
    expect(staleOnMove(shown("Hecho"))).toBe(true);
    expect(staleOnMove(shown({ message: "Archivado", action: { label: "Deshacer", onClick: () => {} } }))).toBe(false);
    expect(staleOnMove(shown({ message: "Falló", tone: "error" }))).toBe(false);
    expect(staleOnMove(shown({ message: "Enviando", tone: "loading" }))).toBe(false);
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

describe("plan 188", () => {
  it("a steady snack (a held send: the backend's clock) runs on under hover and focus, and goes at its time", () => {
    pause("focus");
    snack.loading("Sending…", { duration: 3000, steady: true, action: { label: "Undo", onClick() {} } });
    pause("hover");
    vi.advanceTimersByTime(1000);
    expect(elapsedAt(useSnack.getState().countdown, clock.now())).toBe(1000);
    vi.advanceTimersByTime(2000);
    expect(message()).toBeNull();
    // the reasons stay for the next one
    snack("Archivado", { action: { label: "Undo", onClick() {} } });
    vi.advanceTimersByTime(10_000);
    expect(message()).toBe("Archivado");
  });

  it("a snack with an action says how to reach it: Z only when z runs that very undo", () => {
    snack("Archived", { action: { label: "Undo", name: "Undo archive", onClick() {} } });
    expect(current()?.spoken).toBe("Archived. Undo archive: press F6 to reach it.");
    const undo = registerUndo(() => {});
    snack("Archived", { action: { label: "Undo", name: "Undo archive", undo } });
    expect(current()?.spoken).toBe("Archived. Undo archive: press Z, or F6 to reach it.");
    snack("Archived");
    expect(current()?.spoken).toBe("Archived");
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

it("withdrawal removes private text from the fading body and announcement without losing Undo", async () => {
  const { withdrawSnack, snackRetentionForTests } = await import("./snack");
  const undo = registerUndo(() => {});
  snack.warning("Recipient refused", { id: "private-receipt", description: "private@example.test" });
  withdrawSnack("private-receipt");
  expect(useSnack.getState().current).toBeNull();
  expect(useSnack.getState().last).toBeNull();
  expect(useSnack.getState().undo).toBe(undo);
  expect(snackRetentionForTests()).toEqual({ queued: [], displaced: [] });
});

it("a loading snack given a lifetime spins until then, and isn't waiting on a result under its id (plan 158)", async () => {
  const { snackRetentionForTests } = await import("./snack");
  snack.loading("Sending…", { id: "held", duration: 5000 });
  expect(current()).toMatchObject({ tone: "loading", duration: 5000 });
  snack.success("Message sent", { background: true });
  expect(message()).toBe("Message sent");
  expect(snackRetentionForTests().displaced).toEqual([]);
  snack.loading("Sending…", { id: "held-2", duration: 5000 });
  vi.advanceTimersByTime(5000);
  expect(current()).toBeNull();
  // without one it still waits for its result
  snack.loading("Working", { id: "job" });
  expect(current()?.duration).toBe(Infinity);
});
