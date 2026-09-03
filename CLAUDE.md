# CLAUDE.md — LLM Wiki schema for `docs/`

This repository's documentation under `docs/` is an **LLM Wiki**: a
persistent, interlinked set of markdown pages that you (the LLM) maintain and
humans read. This file is the schema — what the wiki looks like and which
workflows to follow. Page-level conventions are in
[`docs/conventions.md`](docs/conventions.md); read that too before editing.

The project itself is summarized in [`docs/overview.md`](docs/overview.md);
every page is catalogued in [`docs/index.md`](docs/index.md).

## The three layers

| Layer       | Location                                                                                                                                                                                                                                                                                                                      | Rule                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw sources | `src/`, `src-tauri/`, `e2e/`, `scripts/`, `schema/scenario.schema.json`, `vendor/ocpp-schemas/`, `docs/examples/`, `docs/images/`, READMEs beside code (`e2e/README.md`, `scripts/steve-verify/README.md`, `scripts/poc/README.md`, `src/utils/scenarios/README.md`, `examples/testcontainers-java/README.md`), GitHub issues | Ground truth. Wiki work reads them and never rewrites them. Code changes go through normal engineering PRs. `vendor/ocpp-schemas/` is verbatim-only (CC BY-ND). |
| Wiki        | `docs/` — `overview.md`, `index.md`, `log.md`, `conventions.md`, `entities/`, `concepts/`, `sources/`, `analyses/`                                                                                                                                                                                                            | You own it: create, update, cross-link, keep consistent.                                                                                                        |
| Schema      | This file                                                                                                                                                                                                                                                                                                                     | Co-evolved with the humans; update it when a workflow changes.                                                                                                  |

`README.md` is the GitHub landing page (quick start + links into the wiki), not
a wiki page. Keep it short; deep content belongs in `docs/`.

## Layout

```
docs/
├── overview.md        # master summary — what the project is, how pieces fit
├── index.md           # catalog of every page with one-line summary (update on every change)
├── log.md             # append-only operations log
├── conventions.md     # page format, naming, linking rules
├── entities/          # shipped components + external systems (cli, daemon, web-console, docker-image, mcp-endpoint, analyze, scenario-templates, csms-peers, ocpp-debugkit, …)
├── concepts/          # formats / protocols / mechanisms (control-plane, scenario-format, trace-format, state-persistence, log-format, access-control, network-simulation, ocpp-versions-and-transports, security-profiles, local-vs-remote-mode)
├── sources/           # one summary page per raw source (never a copy)
├── analyses/          # comparisons, migrations, syntheses, "how to choose"
├── examples/          # RAW: scenario JSON + reverse-proxy examples (referenced by Dockerfile, compose, e2e — do not move)
└── images/            # RAW: screenshots
```

Page frontmatter (`title`, `type`, `summary`, `sources`, `related`, `updated`)
and the one-canonical-table rule are defined in `docs/conventions.md`.

## Workflows

### Ingest — something new enters the knowledge base

Triggers: a merged PR that changes behaviour, a new flag / RPC method / node
type, a new issue with a design decision, a new README beside code, an
external document the maintainer hands you.

1. Read the raw source (diff, file, issue). Note the facts, defaults, error
   codes and the issue number behind each decision.
2. Decide where each fact lives: the entity page for the component, the
   concept page for a cross-cutting mechanism, a new `sources/` page if the
   raw source is a document worth summarizing, an `analyses/` page if the
   result is a comparison or a synthesized answer.
3. Update the canonical page; then update every page that links to or
   restates the fact (search with `grep -rn "<term>" docs/`). A single
   feature typically touches 3–10 pages.
4. If a page is new or renamed: add it to `index.md`, add `related:` links
   both ways, and ensure at least one inbound link.
5. Keep paths in code comments / `--help` text / `schema/scenario.schema.json`
   that point into `docs/` working (`grep -rn "docs/" src schema docker-compose.yml Dockerfile examples`).
6. Append a `log.md` entry: `## [YYYY-MM-DD] ingest | <title>` + pages touched.
7. Bump `updated:` on each page you changed.

Do the ingest in the **same PR** as the code change whenever you are the one
making the code change.

### Query — answer a question from the wiki

1. Read `docs/index.md` first, then open the 2–5 pages whose summaries match.
2. Answer with citations to page paths and, for behavioural claims, to the
   raw source (`src/...`, issue number). If the wiki and the code disagree,
   trust the code, answer from the code, and file a lint fix.
3. If the answer required synthesis worth keeping (a comparison, a decision
   rationale, a migration path), file it as an `analyses/` page, link it from
   `index.md`, and log it as `query | <title>`.

### Lint — periodic health check

Run when asked, after a batch of ingests, or when something looks stale:

- **Contradictions** between pages (defaults, versions, method lists).
- **Stale claims** superseded by code — spot-check flag tables against
  `src/cli/main.ts` help text, RPC tables against `src/protocol/methods.ts`,
  MCP tools against `src/cli/server/mcp/tools.ts`, template ids against
  `src/utils/scenarios/`, node types against `schema/scenario.schema.json`.
- **Broken links / anchors** — relative links must resolve; run a quick check:

  ```bash
  # relative links in docs/ that do not resolve to a file
  grep -rnoE '\]\((\.\.?/[^)#]+)' docs --include='*.md' | while IFS=: read -r f _ l; do
    p="${l#](}"; [ -e "$(dirname "$f")/$p" ] || echo "$f -> $p"; done
  ```

- **Orphans** — every page listed in `index.md`; every page has an inbound
  link from a page other than `index.md`.
- **Missing pages** — a concept mentioned on three or more pages without its
  own page probably deserves one.
- **Duplication** — the same table on two pages: keep one, link the other.
- Log the pass as `lint | <what was checked / fixed>`.

## Conventions that matter most (summary of `docs/conventions.md`)

- English; precise about defaults, error codes, exit codes and "never / always"
  guarantees — those sentences are the contract.
- Relative markdown links; repo-relative links to raw sources; issue numbers
  for provenance (index in `docs/sources/github-issues.md`).
- One canonical table per fact. CP command methods live in
  `concepts/control-plane.md`; CLI flags in `entities/cli.md`; daemon-only
  flags are repeated in `entities/daemon.md` deliberately (that page is the
  operator's entry point) — keep both in sync.
- `index.md` and `log.md` change in the same commit as the pages.

## Human ↔ LLM division of labour

Humans: write code, curate which sources matter, ask questions, review wiki
PRs, decide what is out of scope. LLM: summarizing, cross-referencing, filing,
index / log bookkeeping, consistency checks, and flagging contradictions or
gaps back to the humans.
