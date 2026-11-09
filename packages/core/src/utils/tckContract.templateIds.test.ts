import { describe, expect, it } from "vitest";

import { getTemplateById, scenarioTemplates } from "./scenarioTemplates";

// GOLDEN TEST FOR AN EXTERNAL CONSUMER (#346 item 2).
//
// open-ocpp-tck (github.com/juherr/open-ocpp-tck) addresses these templates by
// id: `load_scenario_template { connector, templateId }` and the
// `@template:<id>` tags in its Gherkin. The ids are part of the contract with
// it, so the list below only grows:
//
//   - A new `cert16-*` template needs no change here (add it to the list if you
//     want it protected from now on).
//   - Never delete or edit an id in the list to make this test pass. To
//     rename or remove a template, keep the old id resolvable as an alias
//     (register a template entry under the old id that carries the same
//     scenario) for at least one minor release; the id then still passes
//     here. The TCK pins the simulator image by digest, so
//     the alias period is what gives it time to re-pin.
//   - Ownership of the JSON files is an open question (#346 comments); the
//     ids are not.
// The contract is described in docs/entities/cli.md ("TCK contract").

/** Every `cert16-*` id shipped when the contract was pinned (on main, 11438b06). */
const PINNED_CERT16_IDS = [
  "cert16-octt-strictness-probe",
  "cert16-reservation-basic",
  "cert16-tc001-cold-boot",
  "cert16-tc003-charging-plugin-first",
  "cert16-tc004-charging-id-first",
  "cert16-tc005-ev-side-disconnect",
  "cert16-tc010-remote-start",
  "cert16-tc011-remote-start-stop",
  "cert16-tc012-remote-stop",
  "cert16-tc013-hard-reset",
  "cert16-tc014-soft-reset",
  "cert16-tc017-unlock-occupied",
  "cert16-tc018-unlock-failure",
  "cert16-tc019-get-configuration-all",
  "cert16-tc019-get-configuration-key",
  "cert16-tc021-change-configuration",
  "cert16-tc023-1-authorize-invalid",
  "cert16-tc023-2-authorize-expired",
  "cert16-tc023-3-authorize-blocked",
  "cert16-tc024-lock-failure",
  "cert16-tc026-remote-start-rejected",
  "cert16-tc028-remote-stop-rejected",
  "cert16-tc031-unlock-unknown-connector",
  "cert16-tc042-1-get-local-list-version-not-supported",
  "cert16-tc042-2-get-local-list-version-empty",
  "cert16-tc043-1-send-local-list-not-supported",
  "cert16-tc043-3-send-local-list-failed",
  "cert16-tc043-4-send-local-list-full",
  "cert16-tc043-5-send-local-list-differential",
  "cert16-tc044-1-firmware-update",
  "cert16-tc044-2-firmware-download-failed",
  "cert16-tc044-3-firmware-install-failed",
  "cert16-tc045-1-get-diagnostics",
  "cert16-tc048-1-reserve-now-faulted",
  "cert16-tc048-2-reserve-now-occupied",
  "cert16-tc048-3-reserve-now-unavailable",
  "cert16-tc048-4-reserve-now-rejected",
  "cert16-tc051-cancel-reservation",
  "cert16-tc052-cancel-reservation-rejected",
  "cert16-tc054-trigger-message",
  "cert16-tc055-trigger-message-rejected",
  "cert16-tc056-central-smart-charging-txdefault",
  "cert16-tc057-central-smart-charging-txprofile",
  "cert16-tc059-remote-start-with-profile",
  "cert16-tc061-clear-cache",
  "cert16-tc064-data-transfer",
  "cert16-tc066-get-composite-schedule",
  "cert16-tc067-clear-charging-profile",
] as const;

describe("TCK contract: cert16-* template ids only grow (#346)", () => {
  it("pins every id that was ever shipped, and none repeats", () => {
    expect(new Set(PINNED_CERT16_IDS).size).toBe(PINNED_CERT16_IDS.length);
  });

  it.each(PINNED_CERT16_IDS)("%s still resolves", (id) => {
    expect(getTemplateById(id)).toBeDefined();
  });

  it("the registry holds at least the pinned ids", () => {
    const shipped = new Set(
      scenarioTemplates
        .map((t) => t.id)
        .filter((id) => id.startsWith("cert16-")),
    );
    expect(PINNED_CERT16_IDS.filter((id) => !shipped.has(id))).toEqual([]);
    expect(shipped.size).toBeGreaterThanOrEqual(PINNED_CERT16_IDS.length);
  });
});
