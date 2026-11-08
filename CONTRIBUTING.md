# Contributing

## Checks

Before pushing, run the checks CI runs: `bun run lint`, `bun run check:boundaries`, `bun run format:check`, `bun run typecheck` and `bun run test` ([Testing strategy](docs/analyses/testing-strategy.md)). Type errors fail the build.

## Issues and pull requests

Open an issue with one of the [issue forms](.github/ISSUE_TEMPLATE) (bug report or feature request); the form asks for what a maintainer needs to reproduce the problem: OCPP version and transport, how you run the simulator, and the wire trace. A pull request opens with [a template](.github/pull_request_template.md) holding the checklist of this page. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Documentation

`docs/` is an LLM-maintained wiki. [`CLAUDE.md`](CLAUDE.md) is its schema (layers, layout, ingest / query / lint workflows) and [`docs/conventions.md`](docs/conventions.md) holds the page conventions. When a change alters behaviour, update the affected wiki pages in the same PR (and `docs/index.md` when a page is added, renamed or removed). Name the branch `<type>/<issue number>-<slug>`, close or reference the issue in the PR body, and say in the PR description which pages changed and why; `docs/log.md` is a frozen archive and is no longer appended to.

**Proposing a new scenario node?** The format does sequence, wait, select, loop and read, and nothing that computes. A node must be a parameter of a behavior, a wait, a verb the station already has on `ctx`, or one of the listed decision nodes; anything else is a behavior selected with `useBehavior` and params. The rules and the reasons are in [`docs/concepts/scenario-format.md`](docs/concepts/scenario-format.md#what-the-format-will-not-do).

## Web console strings

User-visible text in `apps/web` goes through react-i18next, never a string literal: `const { t } = useTranslation(); t("scenarios.count.step", { count })`. Add the key to `apps/web/src/i18n/locales/en/<namespace>.json` and to `ja/`, `zh-CN/` and `fr/` (counted nouns take `_one` / `_other` in English, `_other` in ja / zh-CN and `_one` / `_many` / `_other` in fr; placeholders are `{{name}}`). `bunx vitest run apps/web/src/i18n` fails when a locale misses a key or a plural form, or changes a placeholder, and an unknown key fails `bun run typecheck`. Do not translate OCPP action names, protocol fields, enum values, identifiers or user content. Details: [Web console internationalization](docs/concepts/web-console-i18n.md).

## Contribution terms

- **License.** The project is licensed under [Apache-2.0](LICENSE). By opening a pull request you agree that your contribution is licensed under the same terms (Section 5 of the license: a contribution submitted for inclusion is under its terms unless you state otherwise). Only submit what you have the right to submit. There is no CLA and no sign-off requirement.
- **Third-party code.** Do not copy code from another project unless its license allows it and you say so in the pull request. The OCPP JSON schemas under `packages/ocpp/vendor/ocpp-schemas/` are verbatim copies and stay that way. Check behavior against the OCPP specification itself and cite the clause in the pull request; do not port it from another simulator.
- **AI-generated code.** Assistance from AI tools is welcome, and the same rules apply to it as to anything else you submit. You are the author of record: read, understand and test every line, and be able to explain it in review. You are responsible for its license status as for hand-written code, so do not submit output you suspect reproduces someone else's code. Name the tool in the pull request description when it wrote a substantial part of the change. A maintainer may close a pull request that shows no sign of having been read or run.

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
