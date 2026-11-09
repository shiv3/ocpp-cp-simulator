<!-- Title: conventional-commit style, e.g. "fix(ocpp16): ..." or "feat(cli): ...". English only. -->

## What and why

<!-- What changes, and the issue it fixes: "Closes #N" (or "Refs #N" when only part of it is done). For protocol behavior, cite the clause of the specification. -->

## Checklist

- [ ] `bun run lint`, `bun run check:boundaries`, `bun run format:check`, `bun run typecheck` and the tests near the change pass ([Checks](https://github.com/shiv3/ocpp-cp-simulator/blob/main/CONTRIBUTING.md#checks)).
- [ ] A behavior change is covered by a test. Golden wire fixtures I re-recorded are listed below with the reason.
- [ ] Docs: the affected `docs/` pages, `docs/index.md` and `docs/log.md` are updated in this PR ([Documentation](https://github.com/shiv3/ocpp-cp-simulator/blob/main/CONTRIBUTING.md#documentation)).
- [ ] Web console text goes through react-i18next, with `en`, `ja` and `zh-CN` keys ([Web console strings](https://github.com/shiv3/ocpp-cp-simulator/blob/main/CONTRIBUTING.md#web-console-strings)). Not applicable if `apps/web` is untouched.
- [ ] The PR carries the labels and milestone of the issue it fixes; a CI, build or test-tooling change uses `area:tooling` with `type:testing` or `type:refactor` ([Triage](https://github.com/shiv3/ocpp-cp-simulator/blob/main/CONTRIBUTING.md#pull-requests)).
- [ ] I wrote or reviewed every line, and I did not copy code from a project whose license does not allow it ([Contribution terms](https://github.com/shiv3/ocpp-cp-simulator/blob/main/CONTRIBUTING.md#contribution-terms)).

## Golden fixtures re-recorded

<!-- Fixture and reason, or "none". -->
