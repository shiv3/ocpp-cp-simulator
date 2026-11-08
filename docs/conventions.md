---
title: Wiki conventions
type: conventions
summary: How pages in docs/ are named, structured, linked and kept consistent — the human-readable companion to the LLM schema in CLAUDE.md.
updated: 2026-11-08
---

# Wiki conventions

`docs/` is organized as an **LLM Wiki**
([pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)):
a persistent, interlinked set of markdown pages that an LLM maintains and
humans read, with the operating schema in the repository-root
[`CLAUDE.md`](../CLAUDE.md). This page records the page-level conventions.

## Layers

| Layer           | Where                                                                                                                                                                                                                 | Who edits                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Raw sources** | The code (`packages/`, `apps/`, `src-tauri/`, `e2e/`, `scripts/`), `packages/core/schema/`, `packages/ocpp/vendor/ocpp-schemas/`, `docs/examples/`, `docs/images/`, the READMEs that live next to code, GitHub issues | Engineers, through normal PRs. The wiki never rewrites them; `packages/ocpp/vendor/ocpp-schemas/` is verbatim-only. |
| **Wiki**        | `docs/` — `overview.md`, `index.md`, this page, and `entities/`, `concepts/`, `sources/`, `analyses/`                                                                                                                 | The LLM (with human review in the PR); humans may edit too.                                                         |
| **Schema**      | `CLAUDE.md` at the repo root                                                                                                                                                                                          | Humans and the LLM, co-evolved.                                                                                     |

`README.md` at the root is the GitHub landing page, not a wiki page: it holds
the quick start and links into the wiki. `CONTRIBUTING.md` holds the
contribution rules: pre-push checks, the wiki update rule, the contribution
terms (license, third-party and AI-generated code) and the issue / PR triage
convention (labels, milestones, release-drafter bumps); the issue forms,
`.github/pull_request_template.md` and `CODE_OF_CONDUCT.md` sit beside it.

## Page types and directories

| Directory   | `type:`    | Holds                                                                                                                                                                                                                       | Naming                                           |
| ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `entities/` | `entity`   | Concrete things: shipped components (CLI, daemon, web console, Docker image, MCP endpoint, subcommands, templates) and external systems (CSMS peers, DebugKit)                                                              | The thing's name: `daemon.md`, `docker-image.md` |
| `concepts/` | `concept`  | Formats, protocols and mechanisms that span components (control plane, scenario format, trace format, persistence, log format, access control, network simulation, versions/transports, security profiles, Local vs Remote) | The concept's name: `control-plane.md`           |
| `sources/`  | `source`   | One page per raw source (or coherent group of sources): what it is, key facts, how to use it. Never a copy of the source.                                                                                                   | `<what>-readme.md`, `<file>.md`                  |
| `analyses/` | `analysis` | Comparisons, migrations, syntheses, "how to choose" pages — answers worth keeping                                                                                                                                           | Descriptive: `choosing-an-interface.md`          |

Root files: `overview.md` (master summary), `index.md` (catalog of every
page), `conventions.md` (this page). `log.md` and `sources/github-issues.md`
are frozen archives (see below).

## Page format

Every page starts with YAML frontmatter:

```yaml
---
title: Human-readable title
type: entity | concept | source | analysis | overview | conventions
summary: One sentence that could stand alone in index.md.
sources: # raw files, issues, or sibling pages this page was derived from
  - apps/cli/src/main.ts
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
  (`../../packages/core/schema/scenario.schema.json`, `../../packages/contracts/src/`). Link to GitHub
  issues by number and, on first mention in a page, with the full URL. Cite the issue number inline
  on the page itself: provenance lives with the claim. The old issue table,
  [`sources/github-issues.md`](sources/github-issues.md), is a frozen archive
  (as of 2026-11-08); newer provenance is in `git log --grep '#N'`.
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
in the commit message and PR description). Paths that appear in code comments, `--help`
text and `packages/core/schema/scenario.schema.json` point into `docs/…`; keep them working
when moving pages.

## `index.md`, history and archives

- `index.md` lists every page under its category with its one-line summary.
  Update it in the same commit as any page added, renamed or removed.
- There is no operations log and no issue table to append to. Wiki changes are
  recorded by git: the commit message and the PR description say which pages
  changed and why. Read history with `git log -- docs/` (add `-p` for diffs),
  `git log --grep '#N'` for an issue or PR number, or the PR that closed the
  issue.
- Branches are named `<type>/<issue number>-<slug>` (for example
  `docs/746-trigger-message`); the PR body closes or references its issues
  (`Closes #N` / `Refs #N`).
- [`log.md`](log.md) (operations log) and
  [`sources/github-issues.md`](sources/github-issues.md) (issue → topic → pages
  table) are frozen archives, no longer updated as of 2026-11-08. Do not append
  to them; pages keep citing issue numbers inline instead.
