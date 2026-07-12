/**
 * specs/authorize.ts -- TC_023 Authorize Outcome scenarios (issue #181's
 * local-start Authorize gate, default ON: every local transaction-start
 * node now sends Authorize.req and awaits Authorize.conf BEFORE
 * StartTransaction.req). These three specs exercise the three denial
 * outcomes (Invalid/Expired/Blocked); each asserts the CP sends Authorize
 * with the tag, receives the expected idTagInfo.status (uniqueId-paired,
 * not a log-window grep), does NOT send StartTransaction.req, and that no
 * transaction row lands in SteVe's DB for that tag -- pinning the #181
 * "denial is a logged skip, not an error" design decision end-to-end
 * against a real CSMS.
 *
 * Provisioning (02-provision.sh) sets each tag's SteVe state:
 *   - CERT023-INV: NOT present in ocpp_tag (deleted after the general
 *     auto-discovery insert) -- SteVe's AuthTagServiceLocal.decideStatus()
 *     returns INVALID when `ocppTagRepository.getRecord(idTag)` is null.
 *   - CERT023-EXP: ocpp_tag.expiry_date set in the past -- decideStatus()
 *     checks isExpired() (expiry_date < now) before ACCEPTED.
 *   - CERT023-BLK: ocpp_tag.max_active_transaction_count = 0 -- decideStatus()
 *     checks isBlocked() (max_active_transaction_count == 0) first, ahead of
 *     the expiry check.
 * (See scripts/steve-verify/02-provision.sh's "TC_023 Authorize outcome
 * tags" section for the exact SQL; verified directly against SteVe's
 * OcppTagService/AuthTagServiceLocal/OcppTagActivityRecordUtils source
 * inside the running steve-app-1 container.)
 */

import {
  assertEq,
  assertIdTagInfoStatus,
  assertLineMatches,
  assertNotSent,
  type AssertRecorder,
} from "../assert";
import type { ScenarioSpec } from "../spec-types";
import type { SteveTx } from "../steve";

async function assertNoTransactionForTag(
  cpId: string,
  idTag: string,
  db: SteveTx,
  rec: AssertRecorder,
): Promise<void> {
  const count = await db.txCountForTag(cpId, idTag);
  assertEq(
    rec,
    count,
    "0",
    `DB: no transaction row created for ${idTag} (Authorize denied)`,
  );
}

// ---------------------------------------------------------------------------
// TC_023.1 Authorize Outcome (Invalid) -- unknown idTag.
// ---------------------------------------------------------------------------

export const tc0231AuthorizeInvalidSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc023-1-authorize-invalid",
  description:
    "TC_023.1 Authorize Outcome (Invalid): unknown idTag CERT023-INV -> Authorize.conf Invalid, no StartTransaction.",
  connector: 1,
  bootWaitSecs: 4,
  // plug-in (instant) + Authorize round-trip (~1s) + delay-1(2s) + plug-out + tail.
  holdSecs: 15,
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"Authorize".*"idTag":"CERT023-INV"/,
      "Authorize.req sent with idTag CERT023-INV",
    );
    assertIdTagInfoStatus(
      rec,
      frames,
      "Authorize",
      "Invalid",
      "Authorize.conf idTagInfo.status is Invalid",
    );
    assertNotSent(
      rec,
      frames,
      "StartTransaction",
      "sent",
      "no StartTransaction sent (Authorize denied)",
    );
    // Load-bearing proof of the #181 "denied start is a logged skip, not an
    // error" design decision: the executor must fall through to plug-out/end
    // instead of throwing/hanging. (The warn-level "Transaction start
    // denied" log line itself isn't checkable here -- Logger routes WARN to
    // console.warn, which sim.ts captures as stderr, never merged into the
    // stdout `lines` this spec sees; see sim.ts's readLines(proc.stdout, …)
    // vs stderrLines.)
    assertLineMatches(
      rec,
      lines,
      /"event":"scenario_completed"/,
      "scenario ran to completion despite the denied transaction start",
    );

    await assertNoTransactionForTag(cpId, "CERT023-INV", db, rec);
  },
};

// ---------------------------------------------------------------------------
// TC_023.2 Authorize Outcome (Expired) -- expiry_date in the past.
// ---------------------------------------------------------------------------

export const tc0232AuthorizeExpiredSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc023-2-authorize-expired",
  description:
    "TC_023.2 Authorize Outcome (Expired): idTag CERT023-EXP has expiry_date in the past -> Authorize.conf Expired, no StartTransaction.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 15,
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"Authorize".*"idTag":"CERT023-EXP"/,
      "Authorize.req sent with idTag CERT023-EXP",
    );
    assertIdTagInfoStatus(
      rec,
      frames,
      "Authorize",
      "Expired",
      "Authorize.conf idTagInfo.status is Expired",
    );
    assertNotSent(
      rec,
      frames,
      "StartTransaction",
      "sent",
      "no StartTransaction sent (Authorize denied)",
    );
    // See TC_023.1's spec above for why this checks scenario_completed
    // rather than the (stderr-only) warn log line.
    assertLineMatches(
      rec,
      lines,
      /"event":"scenario_completed"/,
      "scenario ran to completion despite the denied transaction start",
    );

    await assertNoTransactionForTag(cpId, "CERT023-EXP", db, rec);
  },
};

// ---------------------------------------------------------------------------
// TC_023.3 Authorize Outcome (Blocked) -- max_active_transaction_count = 0.
// ---------------------------------------------------------------------------

export const tc0233AuthorizeBlockedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc023-3-authorize-blocked",
  description:
    "TC_023.3 Authorize Outcome (Blocked): idTag CERT023-BLK is blocked -> Authorize.conf Blocked, no StartTransaction.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 15,
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"Authorize".*"idTag":"CERT023-BLK"/,
      "Authorize.req sent with idTag CERT023-BLK",
    );
    assertIdTagInfoStatus(
      rec,
      frames,
      "Authorize",
      "Blocked",
      "Authorize.conf idTagInfo.status is Blocked",
    );
    assertNotSent(
      rec,
      frames,
      "StartTransaction",
      "sent",
      "no StartTransaction sent (Authorize denied)",
    );
    // See TC_023.1's spec above for why this checks scenario_completed
    // rather than the (stderr-only) warn log line.
    assertLineMatches(
      rec,
      lines,
      /"event":"scenario_completed"/,
      "scenario ran to completion despite the denied transaction start",
    );

    await assertNoTransactionForTag(cpId, "CERT023-BLK", db, rec);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUTHORIZE_SPECS: ScenarioSpec<any>[] = [
  tc0231AuthorizeInvalidSpec,
  tc0232AuthorizeExpiredSpec,
  tc0233AuthorizeBlockedSpec,
];
