---
title: Web console internationalization
type: concept
summary: The web console is translated into English (default), Simplified Chinese, Japanese and French with react-i18next; resources are JSON per namespace, English is bundled and the other languages load on demand, keys are typed, plural forms follow each language's CLDR rules, and the choice lives in localStorage.
sources:
  - apps/web/src/i18n/ (init, resources, type augmentation, locale JSON, completeness test)
  - apps/web/src/components/LanguageToggle.tsx
related:
  - ../entities/web-console.md
  - local-vs-remote-mode.md
  - ../entities/scenario-templates.md
updated: 2026-11-14
---

# Web console internationalization

Issue #634 (French: #788). The console ships four languages: **English** (`en`,
the default and the fallback), **Simplified Chinese** (`zh-CN`), **Japanese**
(`ja`) and **French** (`fr`).

## Behaviour

- The language selector is a dropdown at the bottom-left of the sidebar, next to the dark / light theme toggle and built the same way.
- The choice is stored in `localStorage` under `ocpp-cp.console.locale` (written when the user picks a language) and applied to `<html lang>`. It is global: Local and Remote mode share it.
- The browser language is never consulted: with nothing saved the console is English.
- A key missing from the active language falls back to English.
- Only display text is translated. OCPP action names, protocol field names, enum values in raw messages, identifiers and user-provided content (charge point names, scenarios a user wrote) are never translated, and a translated label never changes a value sent over the wire or stored. Built-in scenario template names and descriptions are translated by template id (`templates.<id>.name` / `.description`) and displayed in place of the template's own text; the template data is unchanged.
- Not covered yet: text produced by other workspace packages (the analyze disclaimer, timeline summaries, `@ocpp-debugkit/toolkit` output, two core errors).

## How it works

[react-i18next](https://react.i18next.com/) with `i18next-browser-languagedetector` (reads only `localStorage`, key above) and `i18next-resources-to-backend`. `apps/web/src/i18n/index.ts` initialises i18next; `main.tsx` waits for `i18nReady` so the first paint is already in the saved language, but at most `I18N_FIRST_PAINT_WAIT_MS` (300 ms, `i18n/firstPaint.ts`, #899): past the bound the console renders in English and switches when the locale chunk arrives. Components call `const { t } = useTranslation()` (re-renders on language change); code outside React imports `t` from `@/i18n`. Component tests need no provider: `test/setup.dom.ts` imports the module, which initialises English synchronously.

- **Resources.** `locales/<locale>/<namespace>.json`, one file per namespace (`common`, `settings`, `scenarios`, ...). Keys are flat dotted strings (`keySeparator: false`) such as `"scenarios.count.step_one"`, written in the file of their namespace; `common` is the default namespace and the rest are fallback namespaces, so call sites carry no `ns:` prefix. Flat JSON loads in Weblate / Crowdin and i18next tooling as is.
- **Lazy loading.** English is imported statically (`resources.ts`) and is part of the main bundle. `ja`, `zh-CN` and `fr` are found with `import.meta.glob` and become one chunk per namespace, fetched by `changeLanguage` the first time the language is chosen (or at start when it is saved). The build output shows them as separate `common-*.js`, `settings-*.js`, ... files.
- **Typed keys.** `i18n/i18next.d.ts` augments `CustomTypeOptions` with the English resources, so `t("no.such.key")` fails `bun run typecheck`. Plural suffixes are stripped from the key type.
- **Plurals.** i18next picks the suffix from `count` with `Intl.PluralRules` for the active language. Each locale carries exactly the CLDR categories of its language: English `_one` / `_other`; `ja` and `zh-CN` only `_other`; French `_one` (0 and 1, so "0 étape"), `_many` (1 000 000 and other exact millions; same text as `_other`) and `_other`. A missing form falls back to English, so the completeness test requires every one.
- **Toasts.** Messages posted through `notify` (`apps/web/src/lib/toast.ts`, [Toast notifications](../entities/web-console.md#toast-notifications)) are translated by the caller; the toast region label is `common.toast.region`.
- **Dynamic keys.** Only built-in scenario templates build keys at runtime (`i18n/templates.ts`), with the original text as `defaultValue`.
- **Strings authored by a behavior.** The `useBehavior` params form (`scenarioEditor.params.*`) translates its own chrome and the titles of the built-in `default.*` params through a fixed table of static keys (`BehaviorParamsForm.tsx`). The `title` and `description` of a params schema a behavior author wrote are shown as written, in the language of the author; so are enum values (they are OCPP status names).

## Adding or changing a string

1. Add `"<namespace>.<area>.<name>": "English text"` to `locales/en/<namespace>.json`. Placeholders are `{{name}}`.
2. For a counted noun, pass `count` and add both forms in English: `"x.items_one": "{{count}} item"` and `"x.items_other": "{{count}} items"`. Call `t("x.items", { count })`; never choose between two keys with `n === 1`. When one sentence has several counts, translate each count with its own plural key and pass the results as plain parameters.
3. Add the same key to `locales/ja/<namespace>.json`, `locales/zh-CN/<namespace>.json` and `locales/fr/<namespace>.json` (plurals: `_other` only in `ja` / `zh-CN`; `_one`, `_many`, `_other` in `fr`).
4. Use it: `const { t } = useTranslation(); t("ns.area.name", { id })`. In module-level constants store the key and call `t` at render time.
5. Run `bunx vitest run apps/web/src/i18n`. `i18n.test.ts` fails when a locale lacks a key present in `en` (plural-aware), has an unknown key, an empty string, different `{{placeholders}}`, or plural forms other than the CLDR categories of its language. It also fails when an `en` string contains Japanese or Chinese characters, when an `en` `templates.*` entry differs from the built-in template's `name` / `description` or names no template (`packages/core/src/utils/scenarios/*.json`), or when a locale's template description, where one exists, names other OCPP messages (`X.req` / `X.conf` tokens) than the template's own (#807). It fails as well when a built-in template has no `en` name and description (#817), so a new template cannot ship untranslated; the per-locale key-completeness tests then require the entry in `ja`, `zh-CN` and `fr`. (Without an entry a template would show its own text in every language.) Changing a template's text therefore means changing `en` in the same commit and the other locales with it.

## Adding a language

Create `locales/<code>/` with a JSON file per namespace (copy `ja/`), and add the code to `LOCALES` and `LOCALE_LABELS` in `i18n/index.ts`. Give each plural key the suffixes of `new Intl.PluralRules("<code>").resolvedOptions().pluralCategories`. No other registration is needed: the lazy loader finds the files and the completeness test covers every locale in `LOCALES`.

French conventions (#788): the whole device (charge point, station) is a _borne de recharge_ / _borne_, an EVSE a _point de charge_, a CP label an _étiquette_, an RFID tag a _badge_, a run an _exécution_; a no-break space (U+00A0) precedes `: ; ? !` and pads `« »` in prose, never inside identifiers, URLs or `{{host}}:{{port}}`.
