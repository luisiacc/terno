// core is environment-agnostic (Node, browser, React Native). Declare only the
// universally available globals it uses instead of pulling in DOM or Node types.
declare function setTimeout(callback: (...args: never[]) => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T>(value: T): T;
declare const performance: { now(): number };
// addresses (plan 32): encoded words, punycode
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class URL {
  constructor(url: string, base?: string);
  readonly hostname: string;
}
