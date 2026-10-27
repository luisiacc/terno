/** Retained normalized message data: UTF-16 strings, owned slots and unique backing buffers. */
export function retainedIncomingBytes(value: unknown): number {
  return charge(value, new Set<object>());
}

function charge(value: unknown, seen: Set<object>): number {
  if (typeof value === "string") return value.length * 2;
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof Uint8Array) return 64 + charge(value.buffer, seen);
  if (value instanceof ArrayBuffer) return value.byteLength;
  const values = Object.values(value);
  let bytes = 64 + values.length * 8;
  for (const child of values) bytes += charge(child, seen);
  return bytes;
}
