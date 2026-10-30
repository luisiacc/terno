// Loaded only by the dedicated dev-server config, before the real worker entry.
const native = { setTimeout, setInterval, clearTimeout, clearInterval };
const pending = new Map();
const totals = { starts: 0, callbacks: 0, clears: 0, shortStarts: 0, shortCallbacks: 0 };
for (const kind of ["setTimeout", "setInterval"]) {
  globalThis[kind] = function (callback, delay, ...args) {
    if (typeof callback !== "function") return Reflect.apply(native[kind], this, [callback, delay, ...args]);
    const short = Number(delay ?? 0) < 1000;
    let handle;
    const wrapped = function (...values) {
      if (kind === "setTimeout") pending.delete(handle);
      totals.callbacks++;
      if (short) totals.shortCallbacks++;
      return Reflect.apply(callback, this, values);
    };
    handle = Reflect.apply(native[kind], this, [wrapped, delay, ...args]);
    totals.starts++;
    if (short) totals.shortStarts++;
    pending.set(handle, { kind, short, delay: Number(delay ?? 0) });
    return handle;
  };
}
for (const kind of ["clearTimeout", "clearInterval"]) {
  globalThis[kind] = function (handle) {
    const result = Reflect.apply(native[kind], this, [handle]);
    if (pending.delete(handle)) totals.clears++;
    return result;
  };
}
globalThis.__w11Timers = () => ({ ...totals, pending: pending.size, shortPending: [...pending.values()].filter (timer => timer.short).length, intervals: [...pending.values()].filter(timer => timer.kind === "setInterval").map(timer => timer.delay).sort((a, b) => a - b) });
