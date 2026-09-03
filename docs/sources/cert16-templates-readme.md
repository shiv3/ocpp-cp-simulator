---
title: "Source: src/utils/scenarios/README.md (cert16 template catalogue)"
type: source
summary: The authoritative mapping of the 44 `cert16-*` templates to OCPP 1.6 certification test cases (TC id, title, profile, CSMS-side operator action), plus numbering notes, configuration side effects, the responseOverride status matrix and the out-of-scope list.
sources:
  - src/utils/scenarios/README.md
  - src/utils/scenarios/cert16-*.json
  - "issues #110, #181"
related:
  - ../entities/scenario-templates.md
  - ../concepts/scenario-format.md
  - steve-verify-readme.md
updated: 2026-09-03
---

# Source: `src/utils/scenarios/README.md`

**What it is.** The catalogue that ships next to the template JSON files. The
wiki does **not** duplicate its 44-row mapping table — read the file for the
per-test-case "CSMS-Side Operator Action" column.

**How to run one** (from the README): open the Scenario Editor, pick a
`cert16-*` scenario, connect a real CSMS (or a harness like gocpp); the
scenario auto-starts once the connector reaches `Available` (Start node
`triggerOn: "connect"`), then follow the listed CSMS-side action.

**Profiles covered.** Core (TC_001, 003, 004, 005, 013, 014, 017, 018, 019.x,
021, 023.x, 024, 031, 061, 064), RemoteTrigger (TC_010, 011, 012, 026, 028,
054, 055), LocalAuthList (TC_042.x, 043.x), Reservation (TC_046, 048.x, 051,
052), SmartCharging (TC_056, 057, 059, 066, 067), Firmware (TC_044.x, 045.1).

**Numbering.** Ids follow the OCPPSC test-case numbering; the README explains
the few places where a template id and a TC number differ.

**Configuration side effects.** The Local Auth List scenarios flip
`LocalAuthListEnabled` via a `configSet` step; scenarios that disable it
(TC_042.1, TC_043.1) leave it disabled for the rest of the CP session.

**Response-override status matrix.** Per-action valid `status` values for the
`responseOverride` node (RemoteStartTransaction: Accepted/Rejected; ReserveNow:
Accepted/Faulted/Occupied/Rejected/Unavailable; SendLocalList:
Accepted/Failed/NotSupported/VersionMismatch; ChangeConfiguration:
Accepted/Rejected/RebootRequired/NotSupported; …). This matrix is deliberately
not encoded in the JSON Schema ([Scenario format](../concepts/scenario-format.md#responseoverride-notes)).

**Out of scope.** TC_007 (cached authorization — local auth list is
write-only today, issue #181), TC_032/037/039 (offline transactions — no
offline queue in the engine), TC_047 (reservation expiry not observable),
TC_049 (no connector 0 reservation), TC_073–TC_088 (security / certificates /
key provisioning).
