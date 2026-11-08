# Contributing

## Checks

Before pushing, run the checks CI runs: `bun run lint`, `bun run check:boundaries`, `bun run format:check`, `bun run typecheck` and `bun run test` ([Testing strategy](docs/analyses/testing-strategy.md)). Type errors fail the build.

## Documentation

`docs/` is an LLM-maintained wiki. [`CLAUDE.md`](CLAUDE.md) is its schema (layers, layout, ingest / query / lint workflows) and [`docs/conventions.md`](docs/conventions.md) holds the page conventions. When a change alters behaviour, update the affected wiki pages in the same PR (and `docs/index.md` when a page is added, renamed or removed). Name the branch `<type>/<issue number>-<slug>`, close or reference the issue in the PR body, and say in the PR description which pages changed and why; `docs/log.md` is a frozen archive and is no longer appended to.

## Web console strings

User-visible text in `apps/web` goes through react-i18next, never a string literal: `const { t } = useTranslation(); t("scenarios.count.step", { count })`. Add the key to `apps/web/src/i18n/locales/en/<namespace>.json` and to `ja/` and `zh-CN/` (counted nouns take `_one` / `_other` in English and `_other` in ja / zh-CN; placeholders are `{{name}}`). `bunx vitest run apps/web/src/i18n` fails when a locale misses a key or changes a placeholder, and an unknown key fails `bun run typecheck`. Do not translate OCPP action names, protocol fields, enum values, identifiers or user content. Details: [Web console internationalization](docs/concepts/web-console-i18n.md).

## Triage

Issues and pull requests are triaged with three label families and six milestones. Their descriptions live on GitHub and are the reference: [labels](https://github.com/shiv3/ocpp-cp-simulator/labels), [milestones](https://github.com/shiv3/ocpp-cp-simulator/milestones).

### Issues

- Every issue carries exactly one `type:*` label (what kind of change), one `area:*` label (which part of the simulator) and one `priority:*` label. When two areas apply, pick the one the change mostly lives in.
- Every open issue belongs to exactly one milestone.
- Other labels (`good first issue`, `help wanted`, `duplicate`, …) may be added on top; they never replace one of the three families.
- An epic or tracking issue follows the same rules.

### Pull requests

A pull request carries the labels and milestone of the issue it fixes. Its `type:*` label matters most: [release-drafter](.github/release-drafter.yml) builds the release notes and the next version from the labels of the pull requests merged since the last release.

| `type:*` label                                        | Release notes section | Version bump |
| ----------------------------------------------------- | --------------------- | ------------ |
| `type:feature`, `type:enhancement`                    | Features              | minor        |
| `type:bug`                                            | Bug Fixes             | patch        |
| `type:documentation`, `type:refactor`, `type:testing` | Maintenance           | patch        |
| none                                                  | uncategorized         | patch        |

`type:research` is for issues only; release-drafter does not know it.

A CI, build or test-tooling change takes `area:tooling` with a non-feature type (`type:testing`, `type:refactor`), never `type:enhancement`: it would trigger a minor release for a change users do not see.
