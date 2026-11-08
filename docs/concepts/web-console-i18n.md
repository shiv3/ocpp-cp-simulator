---
title: Web console internationalization
type: concept
summary: The web console is translated into English (default), Simplified Chinese and Japanese with react-i18next; resources are JSON per namespace, English is bundled and the other languages load on demand, keys are typed, and the choice lives in localStorage.
sources:
  - apps/web/src/i18n/ (init, resources, type augmentation, locale JSON, completeness test)
  - apps/web/src/components/LanguageToggle.tsx
related:
  - ../entities/web-console.md
  - local-vs-remote-mode.md
updated: 2026-11-08
---

# Web console internationalization

Issue #634. The console ships three languages: **English** (`en`, the default and
the fallback), **Simplified Chinese** (`zh-CN`) and **Japanese** (`ja`).

## Behaviour

- The language selector is a dropdown at the bottom-left of the sidebar, next to the dark / light theme toggle and built the same way.
- The choice is stored in `localStorage` under `ocpp-cp.console.locale` (written when the user picks a language) and applied to `<html lang>`. It is global: Local and Remote mode share it.
- The browser language is never consulted: with nothing saved the console is English.
- A key missing from the active language falls back to English.
- Only display text is translated. OCPP action names, protocol field names, enum values in raw messages, identifiers and user-provided content (charge point names, scenarios a user wrote) are never translated, and a translated label never changes a value sent over the wire or stored. Built-in scenario template names and descriptions are translated by template id (`templates.<id>.name` / `.description`) and displayed in place of the template's own text; the template data is unchanged.
- Not covered yet: text produced by other workspace packages (the analyze disclaimer, timeline summaries, `@ocpp-debugkit/toolkit` output, two core errors).

## How it works

[react-i18next](https://react.i18next.com/) with `i18next-browser-languagedetector` (reads only `localStorage`, key above) and `i18next-resources-to-backend`. `apps/web/src/i18n/index.ts` initialises i18next; `main.tsx` waits for `i18nReady` so the first paint is already in the saved language. Components call `const { t } = useTranslation()` (re-renders on language change); code outside React imports `t` from `@/i18n`. Component tests need no provider: `test/setup.dom.ts` imports the module, which initialises English synchronously.

- **Resources.** `locales/<locale>/<namespace>.json`, one file per namespace (`common`, `settings`, `scenarios`, ...). Keys are flat dotted strings (`keySeparator: false`) such as `"scenarios.count.step_one"`, written in the file of their namespace; `common` is the default namespace and the rest are fallback namespaces, so call sites carry no `ns:` prefix. Flat JSON loads in Weblate / Crowdin and i18next tooling as is.
- **Lazy loading.** English is imported statically (`resources.ts`) and is part of the main bundle. `ja` and `zh-CN` are found with `import.meta.glob` and become one chunk per namespace, fetched by `changeLanguage` the first time the language is chosen (or at start when it is saved). The build output shows them as separate `common-*.js`, `settings-*.js`, ... files.
- **Typed keys.** `i18n/i18next.d.ts` augments `CustomTypeOptions` with the English resources, so `t("no.such.key")` fails `bun run typecheck`. Plural suffixes are stripped from the key type.
- **Plurals.** i18next picks `_one` / `_other` from `count` for the active language. English has both; `ja` and `zh-CN` have one plural form and only need `_other`.
- **Dynamic keys.** Only built-in scenario templates build keys at runtime (`i18n/templates.ts`), with the original text as `defaultValue`.

## Adding or changing a string

1. Add `"<namespace>.<area>.<name>": "English text"` to `locales/en/<namespace>.json`. Placeholders are `{{name}}`.
2. For a counted noun, pass `count` and add both forms in English: `"x.items_one": "{{count}} item"` and `"x.items_other": "{{count}} items"`. Call `t("x.items", { count })`; never choose between two keys with `n === 1`. When one sentence has several counts, translate each count with its own plural key and pass the results as plain parameters.
3. Add the same key to `locales/ja/<namespace>.json` and `locales/zh-CN/<namespace>.json` (`_other` only for plurals).
4. Use it: `const { t } = useTranslation(); t("ns.area.name", { id })`. In module-level constants store the key and call `t` at render time.
5. Run `bunx vitest run apps/web/src/i18n`. `i18n.test.ts` fails when `ja` or `zh-CN` lacks a key present in `en` (plural-aware), has an unknown key, an empty string, or different `{{placeholders}}`.

## Adding a language

Create `locales/<code>/` with a JSON file per namespace (copy `ja/`), and add the code to `LOCALES` and `LOCALE_LABELS` in `i18n/index.ts`. No other registration is needed: the lazy loader finds the files and the completeness test covers every locale in `LOCALES`.
