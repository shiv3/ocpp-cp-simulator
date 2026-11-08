import { useSyncExternalStore } from "react";
import en from "./locales/en";
import ja from "./locales/ja";
import zhCN from "./locales/zh-CN";
import type { MessageKey, MessageParams, Messages } from "./types";

export type { MessageKey, MessageParams, Messages } from "./types";

/** Supported UI languages. English is the default and the fallback. */
export const LOCALES = ["en", "zh-CN", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Each language is shown in its own script so it can be found whatever the
 * current UI language is. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  ja: "日本語",
};

export const LOCALE_STORAGE_KEY = "ocpp-cp.console.locale";

const TABLES: Record<Locale, Messages> = { en, "zh-CN": zhCN, ja };

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

function readStoredLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage unavailable: fall back to the default language
  }
  return DEFAULT_LOCALE;
}

let current: Locale =
  typeof window === "undefined" ? DEFAULT_LOCALE : readStoredLocale();
const listeners = new Set<() => void>();

function applyDocumentLang(locale: Locale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}
applyDocumentLang(current);

export function getLocale(): Locale {
  return current;
}

/** Switch language and remember it. The preference is global: it is the same
 * in Local and Remote mode. */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // storage unavailable (private window): the choice just isn't kept
  }
  applyDocumentLang(locale);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Translate `key` into the current language, falling back to English when
 * the active language has no entry. `{name}` placeholders are filled from
 * `params`. Only display text goes through here: OCPP action names, protocol
 * fields, enum values and identifiers must stay as they are. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: MessageParams,
): string {
  const text = TABLES[locale][key] ?? TABLES[DEFAULT_LOCALE][key] ?? key;
  return interpolate(text, params);
}

/** Look up a key that is only known at runtime (for example a built-in
 * scenario template id). Returns `fallback` when no locale has the key, so
 * user-provided content is never touched. */
export function translateDynamic(
  locale: Locale,
  key: string,
  fallback: string,
  params?: MessageParams,
): string {
  const text =
    (TABLES[locale] as Record<string, string | undefined>)[key] ??
    (TABLES[DEFAULT_LOCALE] as Record<string, string | undefined>)[key];
  return text === undefined ? fallback : interpolate(text, params);
}

export type TFunction = typeof t;

const translatorCache = new Map<Locale, TFunction>();
function translatorFor(locale: Locale): TFunction {
  let fn = translatorCache.get(locale);
  if (!fn) {
    fn = (key, params) => translate(locale, key, params);
    translatorCache.set(locale, fn);
  }
  return fn;
}

/** React hook: a `t` bound to the current language that re-renders the
 * component (and changes identity) when the language changes. */
export function useT(): TFunction {
  const locale = useSyncExternalStore(
    subscribe,
    getLocale,
    () => DEFAULT_LOCALE,
  );
  return translatorFor(locale);
}

/** Like `useT` but for keys built at runtime; see `translateDynamic`. */
export function useDynamicT(): (
  key: string,
  fallback: string,
  params?: MessageParams,
) => string {
  const locale = useSyncExternalStore(
    subscribe,
    getLocale,
    () => DEFAULT_LOCALE,
  );
  return (key, fallback, params) =>
    translateDynamic(locale, key, fallback, params);
}

export function useLocale(): [Locale, (locale: Locale) => void] {
  const locale = useSyncExternalStore(
    subscribe,
    getLocale,
    () => DEFAULT_LOCALE,
  );
  return [locale, setLocale];
}

/** Raw tables, for the completeness test. */
export const MESSAGE_TABLES = TABLES;
