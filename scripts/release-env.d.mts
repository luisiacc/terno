export declare const TERNO_DSN: string;
export declare const SENTRY_ORG: string;
export declare const SENTRY_PROJECT: string;
export declare function buildDsn(env?: Record<string, string | undefined>): string;
export declare function buildWebGoogleClientId(env?: Record<string, string | undefined>): string;
export declare function withDotEnv(env?: Record<string, string | undefined>, file?: URL | string): Record<string, string | undefined>;
