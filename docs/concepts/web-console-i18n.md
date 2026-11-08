---
title: Web console internationalization
type: concept
summary: The web console is translated into English (default), Simplified Chinese and Japanese with a small typed in-house layer; the language selector sits beside the theme toggle and the choice lives in localStorage.
sources:
  - apps/web/src/i18n/ (core, locale tables, completeness test)
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
- The choice is stored in `localStorage` under `ocpp-cp.console.locale` and applied to `<html lang>`. It is global: Local and Remote mode share it.
- A key missing from the active language falls back to English.
- Only display text is translated. OCPP action names, protocol field names, enum values in raw messages, identifiers and user-provided content (charge point names, scenarios a user wrote) are never translated, and a translated label never changes a value sent over the wire or stored. Built-in scenario template names and descriptions are translated by template id and displayed in place of the template's own text; the template data is unchanged.

## How it works

No third-party library: `apps/web/src/i18n/index.ts` holds the current locale in a tiny store and exposes `t(key, params)`, the `useT()` hook (re-renders on language change; no provider is needed, so component tests run unchanged in English) and `useDynamicT()` for keys built at runtime. `{name}` placeholders are interpolated. Keys are typed: `MessageKey` is derived from the English tables, so a misspelt key fails `bun run typecheck`.

Locale tables live in `apps/web/src/i18n/locales/<locale>/<namespace>.ts` (one namespace per area of the UI, merged by that locale's `index.ts`). English is the source of truth.

## Adding or changing a string

1. Add `"<namespace>.<area>.<name>": "English text"` to `locales/en/<namespace>.ts`.
2. Add the same key to `locales/ja/<namespace>.ts` and `locales/zh-CN/<namespace>.ts`.
3. Use it: `const t = useT(); t("ns.area.name", { count })`. In module-level constants store the key and call `t` at render time.
4. Run `bun run test:vitest apps/web/src/i18n`. `i18n.test.ts` fails when `ja` or `zh-CN` lacks a key present in `en`, has an unknown key, an empty string, or different `{placeholders}`.

## Adding a language

Create `locales/<code>/` with a file per namespace (copy `ja/`), register it in `LOCALES`, `LOCALE_LABELS` and `TABLES` in `i18n/index.ts`. The completeness test covers every locale in `LOCALES`.
