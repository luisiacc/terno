/** Retained normalized message data: UTF-16 strings, owned slots and unique backing buffers. */
export function retainedIncomingBytes(value: unknown): number {
  const seen = new Set<object>();
  const charge = (value: unknown): number => {
    if (typeof value === "string") return value.length * 2;
    if (value === null || value === undefined) return 0;
    if (typeof value !== "object") return 8;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (value instanceof Uint8Array) return 64 + charge(value.buffer);
    if (value instanceof ArrayBuffer) return value.byteLength;
    const values = Object.values(value);
    return 64 + values.length * 8 + values.reduce<number>((total, child) => total + charge(child), 0);
  };
  return charge(value);
}
