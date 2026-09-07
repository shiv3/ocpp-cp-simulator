---
title: Wiki conventions
type: conventions
summary: How pages in docs/ are named, structured, linked and kept consistent — the human-readable companion to the LLM schema in CLAUDE.md.
updated: 2026-09-03
---

# Wiki conventions

`docs/` is organized as an **LLM Wiki**
([pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)):
a persistent, interlinked set of markdown pages that an LLM maintains and
humans read, with the operating schema in the repository-root
[`CLAUDE.md`](../CLAUDE.md). This page records the page-level conventions.

## Layers

| Layer           | Where                                                                                                                                                                       | Who edits                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Raw sources** | The code (`src/`, `src-tauri/`, `e2e/`, `scripts/`), `schema/`, `vendor/ocpp-schemas/`, `docs/examples/`, `docs/images/`, the READMEs that live next to code, GitHub issues | Engineers, through normal PRs. The wiki never rewrites them; `vendor/ocpp-schemas/` is verbatim-only. |
| **Wiki**        | `docs/` — `overview.md`, `index.md`, `log.md`, this page, and `entities/`, `concepts/`, `sources/`, `analyses/`                                                             | The LLM (with human review in the PR); humans may edit too.                                           |
| **Schema**      | `CLAUDE.md` at the repo root                                                                                                                                                | Humans and the LLM, co-evolved.                                                                       |

`README.md` at the root is the GitHub landing page, not a wiki page: it holds
the quick start and links into the wiki.

## Page types and directories

| Directory   | `type:`    | Holds                                                                                                                                                                                                                       | Naming                                           |
| ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `entities/` | `entity`   | Concrete things: shipped components (CLI, daemon, web console, Docker image, MCP endpoint, subcommands, templates) and external systems (CSMS peers, DebugKit)                                                              | The thing's name: `daemon.md`, `docker-image.md` |
| `concepts/` | `concept`  | Formats, protocols and mechanisms that span components (control plane, scenario format, trace format, persistence, log format, access control, network simulation, versions/transports, security profiles, Local vs Remote) | The concept's name: `control-plane.md`           |
| `sources/`  | `source`   | One page per raw source (or coherent group of sources): what it is, key facts, how to use it. Never a copy of the source.                                                                                                   | `<what>-readme.md`, `<file>.md`                  |
| `analyses/` | `analysis` | Comparisons, migrations, syntheses, "how to choose" pages — answers worth keeping                                                                                                                                           | Descriptive: `choosing-an-interface.md`          |

Root files: `overview.md` (master summary), `index.md` (catalog of every
page), `log.md` (append-only operations log), `conventions.md` (this page).

## Page format

Every page starts with YAML frontmatter:

```yaml
---
title: Human-readable title
type: entity | concept | source | analysis | overview | conventions
summary: One sentence that could stand alone in index.md.
sources: # raw files, issues, or sibling pages this page was derived from
  - src/cli/main.ts
  - "issue #188"
related: # relative links to sibling pages, most important first
  - ../concepts/control-plane.md
updated: YYYY-MM-DD # last substantive edit
---
```

Then a single `# H1` matching `title`, an opening paragraph that says what the
thing is and links to its neighbours, then sections. Reference material (flag
tables, method tables) is welcome — the wiki is the reference — but each fact
has **one canonical table**; other pages link to it rather than copy it.

## Linking

- Use relative markdown links (`[Daemon](entities/daemon.md#health)`), not
  wiki-links, so GitHub renders them. Obsidian follows them too.
- Link to raw sources with repo-relative paths from the page
  (`../../schema/scenario.schema.json`, `../../src/protocol/`). Link to GitHub
  issues by number and, on first mention in a page, with the full URL or via
  [`sources/github-issues.md`](sources/github-issues.md).
- Every page must be reachable from `index.md`, and should have at least one
  inbound link from another page (no orphans).
- Anchors are GitHub-style slugs of headings; when you rename a heading,
  grep for its anchor.

## Language and tone

English, present tense, second person for instructions. Keep the precise
wording of behavioural guarantees (defaults, error codes, exit codes,
"never rejects") — those sentences are the contract users rely on. Cite the
issue number when a behaviour exists because of one.

## Source of truth

The code wins. When a page and the code disagree, fix the page (and record it
in `log.md` as a `lint` entry). Paths that appear in code comments, `--help`
text and `schema/scenario.schema.json` point into `docs/…`; keep them working
when moving pages.

## `index.md` and `log.md`

- `index.md` lists every page under its category with its one-line summary.
  Update it in the same commit as any page added, renamed or removed.
- `log.md` is append-only. One entry per operation, newest last:
  `## [YYYY-MM-DD] <ingest|query|lint|restructure> | <title>` followed by a
  short bullet list of pages touched. `grep "^## \[" docs/log.md | tail -5`
  shows recent activity.
