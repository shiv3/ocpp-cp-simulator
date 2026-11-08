import type en from "./locales/en";

/** Every translatable string key. English is the source of truth. */
export type MessageKey = keyof typeof en;

/** One translation table. Missing keys fall back to English at runtime;
 * `i18n.test.ts` fails when a shipped locale lacks a key. */
export type Messages = Partial<Record<MessageKey, string>>;

export type MessageParams = Record<string, string | number>;
