// core is environment-agnostic (Node, browser, React Native). Declare only the
// universally available globals it uses instead of pulling in DOM or Node types.
declare function setTimeout(callback: (...args: never[]) => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T>(value: T): T;
