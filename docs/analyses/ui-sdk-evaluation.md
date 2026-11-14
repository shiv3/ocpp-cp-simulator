---
title: UI SDK evaluation (spike)
type: analysis
summary: Spike result for #936 — the console's free-text filter combobox rebuilt on Vercel's beta UI SDK (@ui-sdk/react Autocomplete), compared on keyboard behavior, code, bundle cost and risk; recommendation is defer, and fix the one real gap in the existing component.
sources:
  - apps/web/src/console/components/Combobox.tsx
  - apps/web/src/console/components/Combobox.dom.test.tsx
  - apps/web/spikes/ui-sdk-combobox/
  - "issue #936"
related:
  - ../entities/web-console.md
  - testing-strategy.md
  - ../concepts/web-console-i18n.md
updated: 2026-11-14
---

# UI SDK evaluation (spike)

[Issue #936](https://github.com/shiv3/ocpp-cp-simulator/issues/936) asked
whether Vercel's [UI SDK](https://github.com/vercel-labs/ui) (beta,
behavior-first, Apache-2.0) is worth using for one accessible interaction of
the [web console](../entities/web-console.md). This page is the report. The
prototype and the tests that back it are in
[`apps/web/spikes/ui-sdk-combobox/`](../../apps/web/spikes/ui-sdk-combobox/README.md);
no production code, dependency, OCPP behavior or API changed.

**Recommendation: defer.** Do not add the SDK. Fix the one real accessibility
gap of the current component in a normal PR (below). Revisit when the SDK has a
stable release and a control that Radix cannot express shows up.

## The control

The filter `Combobox`
([`Combobox.tsx`](../../apps/web/src/console/components/Combobox.tsx), 198
lines, used by the Charge Points filter bar and the scenarios Active Runs tab) is a text box with
suggestions: **the text is the value** (it is URL state), any text is valid,
options carry a status dot and a hint. It is hand-rolled because Radix has no
combobox (`@radix-ui/react-select` selects a value and has no free text) and a
native `<datalist>` cannot show dots or hints. It was chosen over the scenario
editor because it is self-contained and exactly the "searchable, keyboard
accessible selector" the issue names.

Existing accessibility, read from the code and pinned by 11 tests in
`Combobox.dom.test.tsx`: `role="combobox"` with `aria-expanded`,
`aria-controls`, `aria-autocomplete="list"`, an accessible name; Escape closes
and stops propagation (the side panel's Esc must not fire); Tab closes; Enter
picks the first visible option; outside pointer-down closes.
**Gaps** (executable as `GAP:` tests in the spike):

- No arrow-key navigation inside the list: ArrowDown only opens it. Options are
  reachable by mouse, or by Enter on the _first_ match only.
- No `aria-activedescendant`, so a screen reader hears no highlighted option.
- Options are `<button role="option">` inside a `role="listbox"`: works, but
  buttons in a listbox is not the APG pattern.

## Prototype

[`UiSdkCombobox.tsx`](../../apps/web/spikes/ui-sdk-combobox/UiSdkCombobox.tsx)
(110 lines) has the same props, the same classes and renders through
`Autocomplete` from `@ui-sdk/react@0.1.0-beta.1` (with `@ui-sdk/core` as peer).
The SDK's own `Combobox` is the wrong one: its value is an option and the text
is a query, which would change the filter's meaning (free text stops being
valid). `Autocomplete` is its "the text is the value" control.

## Comparison

| Aspect                                                                 | Current (hand-rolled)                                  | UI SDK `Autocomplete`                                                                                                                                                                                                                                                                                                                                                | Verified how                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Keyboard: ArrowDown/Up highlight, Enter picks highlighted              | No (Enter picks first match only)                      | Yes                                                                                                                                                                                                                                                                                                                                                                  | Spike tests (jsdom)                                                                                                  |
| `aria-activedescendant`, focus stays in input                          | No / yes                                               | Yes / yes                                                                                                                                                                                                                                                                                                                                                            | Spike tests                                                                                                          |
| Escape keeps text and closes; free text allowed                        | Yes                                                    | Yes                                                                                                                                                                                                                                                                                                                                                                  | Spike tests                                                                                                          |
| Clear and chevron buttons                                              | Own code                                               | `AutocompleteClear` / `AutocompleteTrigger`                                                                                                                                                                                                                                                                                                                          | Spike tests (existing behavior); not re-tested for the SDK                                                           |
| "Escape must not reach the side panel"                                 | Explicit `stopPropagation`                             | Not tested; the SDK has its own dismissal layer (`dismissible`, `onDismissAttempt`)                                                                                                                                                                                                                                                                                  | **Not verified**                                                                                                     |
| Screen-reader output                                                   | Not tested (no ARIA for highlight)                     | SDK documents virtual-screen-reader tests in its docs                                                                                                                                                                                                                                                                                                                | **Not verified by us**: no screen reader was run                                                                     |
| Custom code                                                            | 198 lines incl. outside-click, filtering, key handling | 110 lines, mostly markup and classes; no state                                                                                                                                                                                                                                                                                                                       | Line count                                                                                                           |
| Unexpected behavior met                                                | —                                                      | (1) item text, not `value`, is what fills the field when children hold a hint: pass `label=`; (2) filtered-out options stay in the DOM with `hidden`, so tests must exclude them; (3) jsdom lacks `Element.getAnimations`, the SDK throws on popup close, so tests need a shim; (4) `npm install` pulls a second React unless `--legacy-peer-deps`, then hooks throw | Hit while writing the spike                                                                                          |
| Bundle (min / gzip, React excluded, `cn` and icons already in the app) | 3.8 KB / 1.6 KB                                        | **152.9 KB / 46.3 KB** for this one control                                                                                                                                                                                                                                                                                                                          | `measure-size.mjs`; a bundle with several SDK parts would share code, a second control would cost less; not measured |
| Install size                                                           | none                                                   | `@ui-sdk/core` 7.5 MB + `@ui-sdk/react` 3.6 MB unpacked                                                                                                                                                                                                                                                                                                              | `du`                                                                                                                 |
| Runtime overhead                                                       | none measured                                          | not measured                                                                                                                                                                                                                                                                                                                                                         | **Not verified**                                                                                                     |
| React / Vite                                                           | React 19                                               | Peer `react >=19`, `@types/react >=19.2.10`: satisfied by the repo (19.3)                                                                                                                                                                                                                                                                                            | `npm view`, tests ran under Vite                                                                                     |
| Tauri WebView                                                          | works                                                  | **Not verified** (not run in a WebView; needs `getAnimations`, present in current WebKit/Chromium)                                                                                                                                                                                                                                                                   | —                                                                                                                    |
| Localization                                                           | `react-i18next` strings                                | Labels are props (done in the spike); the screen-reader count announcement has an `announcement` override. Its default text language was **not checked**                                                                                                                                                                                                             | Docs only                                                                                                            |
| Maintenance / version risk                                             | Ours                                                   | `0.1.0-beta.1`, "APIs may change before GA" (README)                                                                                                                                                                                                                                                                                                                 | `npm view`                                                                                                           |
| Styling                                                                | Tailwind classes                                       | Unstyled parts, `data-highlighted` etc., same Tailwind classes work                                                                                                                                                                                                                                                                                                  | Spike                                                                                                                |

Step 4 of the issue (an agent with and without the UI SDK skill) was **not
done**: it would measure the agent, not the library, and needs a second
unattended run to compare; it is listed as optional in the issue.

## Decision

Defer, not adopt:

- The SDK does fix the real gap, but at 46 KB gzip for one control (about 30x
  the control), a beta API, and four integration surprises found in a few hours.
- The gap is small and local. A follow-up can add ArrowUp/Down, an active
  index, `aria-activedescendant` and `aria-selected` to the existing 198-line
  component, with the `GAP:` tests turned into ordinary ones. That is cheaper
  than the dependency and keeps the free-text semantics and the Esc contract.
- Not rejected: the behavior model is good and its own Autocomplete tests
  match what we need. Re-evaluate when it has a stable release, if a control
  appears that needs multi-select with chips, async results or drag and drop
  (where hand-rolling costs more than 46 KB).

Rejected alternative: adopt now for this one control. It would put a beta
dependency in the main bundle to fix something 30 lines fix.

## Not done / unverified

- No screen reader (VoiceOver, NVDA) was run; "screen-reader behavior" above is
  from the ARIA attributes and the SDK's documentation only. A manual check is
  still owed before any adoption.
- No Tauri WebView run, no runtime profile, no browser-level (Playwright) test;
  everything ran in jsdom.
- The `Escape` / side panel interplay is not tested for the SDK.
