# Contributing

## Checks

Before pushing, run the checks CI runs: `bun run lint`, `bun run format:check`, `bun run typecheck` and `bun run test` ([Testing strategy](docs/analyses/testing-strategy.md)). Type errors fail the build.

## Documentation

`docs/` is an LLM-maintained wiki. [`CLAUDE.md`](CLAUDE.md) is its schema (layers, layout, ingest / query / lint workflows) and [`docs/conventions.md`](docs/conventions.md) holds the page conventions. When a change alters behaviour, update the affected wiki pages, `docs/index.md` and `docs/log.md` in the same PR.

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
