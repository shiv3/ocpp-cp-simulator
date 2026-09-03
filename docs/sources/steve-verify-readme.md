---
title: "Source: scripts/steve-verify/README.md"
type: source
summary: TypeScript runner + bash environment scripts that verify all 44 `cert16-*` certification templates against a real local SteVe CSMS, driving CSMS-side actions over SteVe's REST API with UI/DB fallbacks and a capability probe.
sources:
  - scripts/steve-verify/README.md
  - scripts/steve-verify/runner/
  - "issues #179, #184"
related:
  - ../entities/csms-peers.md
  - ../entities/scenario-templates.md
  - ../analyses/testing-strategy.md
  - cert16-templates-readme.md
updated: 2026-09-03
---

# Source: `scripts/steve-verify/README.md`

**Purpose.** Automate what used to be a by-hand verification pass: spin up a
real SteVe (open-source OCPP 1.6 Central System), launch the simulator against
it, drive each `cert16-*` scenario's CSMS-side operator action (RemoteStart,
Reset, TriggerMessage, …) and assert the expected wire behavior from the
simulator's log plus SteVe's own transaction/tag data. Started as all-bash,
rewritten as a TypeScript runner (`runner/`) for uniqueId-correlated
assertions.

**Quick start.**

```bash
cd scripts/steve-verify
./01-setup-steve.sh          # clone + bring up local SteVe (idempotent; seeds REST API password)
./02-provision.sh            # register charge boxes / tags / profiles (idempotent)
bun runner/main.ts run-all   # all 44 scenarios via the REST driver
bun runner/main.ts run-all --parallel   # up to 3 lanes (CERTCP1..3)
bun runner/main.ts run cert16-tc010-remote-start --cp CERTCP2 --timeout 60
bun runner/main.ts run --group core|authlist-reservation|remotetrigger-smartcharging|firmware
./99-teardown.sh [--volumes]
```

**Driver model (issue #184).** REST (`/api/v1/operations/*`,
`/api/v1/transactions`, `/api/v1/ocppTags`; Basic auth, JSON, stateless) is
the default (`STEVE_DRIVER` unset or `api`); the manager-UI client is an
explicit fallback (`STEVE_DRIVER=ui`). A few operations have **no** REST
equivalent in SteVe 3.13.0 and always use the UI/DB path — the README's
"Fallback matrix" lists which and why.

**Capability probe.** Every run opens with live, side-effect-free probes of
the SteVe instance and prints which surfaces are available vs falling back
(reservation query API, charge-point provisioning API, charging-profile API,
async task result lookup — tracked as steve-community/steve #2074, #2068,
#2069, #2070). Informational, never a precondition.

**Results.** Each run writes the captured simulator log to
`results/<template-id>.log` and prints a `PASS`/`FAIL` line per check;
`run-all` exits non-zero on any failure. `--retry-failed-isolated` adds an
isolated-retry safety net for parallel runs.

**Prerequisites.** Docker + compose, git/curl/bash 4+, bun, free ports
`18180`/`18443`/`13306` (overridable), shellcheck (optional).

**Other README sections worth knowing exist.** `web_user.api_password`
seeding (REST auth), targeting an existing SteVe deployment, parallel lane
isolation, environment/configuration, known limitations, relationship to
issue #179 (machine-readable verdicts), directory layout.
