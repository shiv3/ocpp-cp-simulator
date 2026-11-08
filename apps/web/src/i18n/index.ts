import i18n, { type ParseKeys, type TFunction } from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";
import { NAMESPACES, enResources } from "./resources";

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

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/** Every translatable string key (plural suffixes stripped). */
export type MessageKey = ParseKeys;

// Non-English languages are separate chunks, fetched when the language is
// first selected. English is excluded: it is bundled (see `resources.ts`).
const lazyResources = import.meta.glob(
  ["./locales/*/*.json", "!./locales/en/*.json"],
  { import: "default" },
) as Record<string, () => Promise<Record<string, string>>>;

function applyDocumentLang(locale: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

/** Resolves when the initial language (the saved one, else English) is ready.
 * `main.tsx` waits for it so the first paint is already translated. */
export const i18nReady: Promise<unknown> = i18n
  .use(LanguageDetector)
  .use(
    resourcesToBackend((language: string, namespace: string) => {
      const load = lazyResources[`./locales/${language}/${namespace}.json`];
      return load ? load() : Promise.reject(new Error("no such resource"));
    }),
  )
  .use(initReactI18next)
  .init({
    resources: { en: enResources },
    // English is bundled; other languages come from the backend above.
    partialBundledLanguages: true,
    supportedLngs: LOCALES,
    fallbackLng: DEFAULT_LOCALE,
    load: "currentOnly",
    ns: NAMESPACES,
    defaultNS: "common",
    fallbackNS: NAMESPACES.slice(1),
    // Keys are flat dotted strings ("common.theme.dark"), not nested objects,
    // and never carry an `ns:` prefix.
    keySeparator: false,
    nsSeparator: false,
    // Only the saved choice is read: never auto-switch from the browser
    // language, English stays the default (issue #634).
    detection: {
      order: ["localStorage"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      // written by `setLocale`, not on every start: only a choice is saved
      caches: [],
    },
    interpolation: { escapeValue: false }, // React escapes
    react: { useSuspense: false },
    // Bundled English resolves synchronously, which tests rely on.
    initAsync: false,
  });

i18n.on("languageChanged", applyDocumentLang);
applyDocumentLang(i18n.language);

/** Current language, one of `LOCALES`. */
export function getLocale(): Locale {
  return isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
}

/** Switch language and remember it (the language detector writes
 * localStorage). The preference is global: it is the same in Local and Remote
 * mode. Resolves once the language's strings are loaded. */
export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // storage unavailable (private window): the choice just isn't kept
  }
}

/** `t` for code outside React components. Components use `useTranslation()`,
 * which also re-renders them when the language changes. Only display text goes
 * through here: OCPP action names, protocol fields, enum values and identifiers
 * must stay as they are. */
export const t = ((...args: unknown[]) =>
  (i18n.t as unknown as (...a: unknown[]) => string)(
    ...args,
  )) as unknown as TFunction;

export type { TFunction };
export default i18n;
