/** Plan 146: Dev mode is for a local run on the dev server; an installed app never reads its environment for keys, whatever it's given. */
export function devModeOf(o: { devUrl: string | undefined; packaged: boolean }): boolean {
  return Boolean(o.devUrl) && !o.packaged;
}
