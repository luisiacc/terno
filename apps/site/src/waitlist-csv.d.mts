export const PLATFORMS: string[];
export function waitlistQuery(platform?: string): string;
export function csvCell(value: unknown): string;
export function toCsv(rows: { email: string; platform: string; created_at: number }[]): string;
export function rowsFromWrangler(stdout: string): { email: string; platform: string; created_at: number }[];
