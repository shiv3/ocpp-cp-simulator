/**
 * specs/remotetrigger-smartcharging.ts -- typed port of the "RemoteTrigger +
 * SmartCharging" bash specs (scripts/steve-verify/specs/cert16-{tc010,tc011,
 * tc012,tc026,tc028,tc054,tc055,tc056,tc057,tc059,tc066,tc067}-*.spec.sh),
 * mirroring run-all.sh's REMOTETRIGGER_SMARTCHARGING array exactly (12
 * scenarios). Each spec asserts AT LEAST what its bash predecessor asserted;
 * CALLRESULT status checks are upgraded to uniqueId-paired correlation
 * (assertResponseStatus) instead of the bash version's log-window grep.
 *
 * cert16-tc026-remote-start-rejected moves here from main.ts (Task 1's proof
 * scenario, kept there unported until this group existed).
 */

import {
  assertEq,
  assertLineAfter,
  assertLineMatches,
  assertNoLineMatches,
  assertNonEmpty,
  assertNotSent,
  assertReceived,
  assertResponseStatus,
  assertSent,
} from "../assert";
import type { ScenarioSpec } from "../spec-types";
import { sleep } from "../util";

function warnOpFailed(op: string, err: unknown): void {
  process.stderr.write(
    `[runner] WARN: steve_op ${op} failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

// ---------------------------------------------------------------------------
// TC_010 Remote Start Transaction -- parks waiting for RemoteStartTransaction;
// on Accepted, StatusNotification(Preparing) -> StartTransaction ->
// StatusNotification(Charging), then bounded MeterValue while charging. No
// tx-stop node in the scenario itself -- drive() cleans up the still-open
// transaction afterward.
// ---------------------------------------------------------------------------

export const tc010RemoteStartSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc010-remote-start",
  description:
    "TC_010 Remote Start Transaction: CSMS RemoteStartTransaction accepted, drives a session; drive() stops it afterward.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 25,
  async drive({ cpId, db, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/RemoteStartTransaction", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        idTag: "CERT-TAG-1",
        chargingProfilePk: "",
      });
    } catch (err) {
      warnOpFailed("RemoteStartTransaction", err);
    }

    // meter-auto's autoIncrement fires every 5s -- wait long enough for at
    // least one MeterValues to land before cleaning up the still-open
    // transaction (confirmed live: a 3s wait here stopped it before the
    // first increment, producing a false FAIL on "MeterValues sent while
    // charging").
    await sleep(8000);
    const txPk = await db.latestTxPk(cpId);
    if (txPk) {
      try {
        await steve.op("v1.6/RemoteStopTransaction", {
          chargePointSelectList: steve.cpSelect(cpId),
          transactionId: txPk,
        });
      } catch (err) {
        warnOpFailed("RemoteStopTransaction", err);
      }
    }
  },
  async assert({ cpId, frames, lines, rec, db }) {
    assertReceived(
      rec,
      frames,
      "RemoteStartTransaction",
      "RemoteStartTransaction.req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "RemoteStartTransaction",
      "Accepted",
      "RemoteStartTransaction accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"status":"Preparing"/,
      "Preparing precedes StartTransaction",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction".*"idTag":"CERT-TAG-1"/,
      "StartTransaction sent with CSMS-supplied idTag (overrides scenario's hardcoded CERT010 fallback)",
    );
    assertSent(rec, frames, "MeterValues", "MeterValues sent while charging");

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        `DB: transaction row exists for ${cpId} with id_tag CERT-TAG-1`,
        "no transaction found",
      );
      return;
    }
    assertNonEmpty(
      rec,
      await db.scalar(
        `SELECT id_tag FROM transaction WHERE transaction_pk=${txPk} AND id_tag='CERT-TAG-1';`,
      ),
      `DB: transaction row exists for ${cpId} with id_tag CERT-TAG-1`,
    );
  },
};

// ---------------------------------------------------------------------------
// TC_011 Remote Start + Remote Stop Transaction -- RemoteStartTransaction ->
// Preparing -> StartTransaction -> Charging with running MeterValue; on
// RemoteStopTransaction, StopTransaction -> Finishing -> Available.
// ---------------------------------------------------------------------------

export const tc011RemoteStartStopSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc011-remote-start-stop",
  description:
    "TC_011 Remote Start + Remote Stop Transaction: both CSMS ops accepted, session completes.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 20,
  async drive({ cpId, db, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/RemoteStartTransaction", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        idTag: "CERT-TAG-2",
        chargingProfilePk: "",
      });
    } catch (err) {
      warnOpFailed("RemoteStartTransaction", err);
    }

    await sleep(3000);
    const txPk = await db.latestTxPk(cpId);

    await sleep(2000);
    if (txPk) {
      try {
        await steve.op("v1.6/RemoteStopTransaction", {
          chargePointSelectList: steve.cpSelect(cpId),
          transactionId: txPk,
        });
      } catch (err) {
        warnOpFailed("RemoteStopTransaction", err);
      }
    }
  },
  async assert({ cpId, frames, lines, rec, db }) {
    assertResponseStatus(
      rec,
      frames,
      "RemoteStartTransaction",
      "Accepted",
      "RemoteStartTransaction accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction".*"idTag":"CERT-TAG-2"/,
      "StartTransaction sent with CSMS-supplied idTag",
    );
    assertResponseStatus(
      rec,
      frames,
      "RemoteStopTransaction",
      "Accepted",
      "RemoteStopTransaction accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StopTransaction".*"reason":"Remote"/,
      "StopTransaction sent with reason Remote",
    );

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        "DB: transaction is closed (stop_timestamp set)",
        "no transaction found",
      );
      return;
    }
    assertNonEmpty(
      rec,
      await db.scalar(
        `SELECT stop_timestamp FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "DB: transaction is closed (stop_timestamp set)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_012 Remote Stop Transaction -- locally-started session (StartTransaction
// + running MeterValue) already Charging when RemoteStopTransaction arrives.
// ---------------------------------------------------------------------------

export const tc012RemoteStopSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc012-remote-stop",
  description:
    "TC_012 Remote Stop Transaction: self-driven session, CSMS RemoteStopTransaction accepted.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 18,
  async drive({ cpId, db, steve }) {
    await sleep(4000);
    const txPk = await db.latestTxPk(cpId);
    if (txPk) {
      try {
        await steve.op("v1.6/RemoteStopTransaction", {
          chargePointSelectList: steve.cpSelect(cpId),
          transactionId: txPk,
        });
      } catch (err) {
        warnOpFailed("RemoteStopTransaction", err);
      }
    }
  },
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction".*"idTag":"CERT012"/,
      "StartTransaction sent with idTag CERT012 (self-driven, not remote-started)",
    );
    assertResponseStatus(
      rec,
      frames,
      "RemoteStopTransaction",
      "Accepted",
      "RemoteStopTransaction accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StopTransaction".*"reason":"Remote"/,
      "StopTransaction sent with reason Remote",
    );

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail("DB: id_tag is CERT012", "no transaction found");
      rec.fail(
        "DB: transaction is closed (stop_timestamp set)",
        "no transaction found",
      );
      return;
    }
    assertEq(
      rec,
      await db.scalar(
        `SELECT id_tag FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "CERT012",
      "DB: id_tag is CERT012",
    );
    assertNonEmpty(
      rec,
      await db.scalar(
        `SELECT stop_timestamp FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "DB: transaction is closed (stop_timestamp set)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_026 Remote Start -- Rejected. Scenario arms a responseOverride
// (RemoteStartTransaction -> Rejected) before parking on the trigger; the
// CSMS sends RemoteStartTransaction on an Available connector and must see
// Rejected with no StartTransaction/transaction row created.
//
// Ported from main.ts (Task 1's proof scenario, held there until this group
// existed) -- logic unchanged.
// ---------------------------------------------------------------------------

interface RemoteStartRejectedDriveState {
  baselineTxPk: string;
}

export const tc026RemoteStartRejectedSpec: ScenarioSpec<RemoteStartRejectedDriveState> =
  {
    templateId: "cert16-tc026-remote-start-rejected",
    description:
      "TC_026 Remote Start — Rejected: CSMS RemoteStartTransaction must be Rejected, no transaction created.",
    connector: 1,
    bootWaitSecs: 4,
    holdSecs: 15,
    async drive({ cpId, db, steve }): Promise<RemoteStartRejectedDriveState> {
      const baselineTxPk = await db.latestTxPk(cpId);
      // Give the scenario time to arm its responseOverride and park on the
      // csmsCallTrigger node before we fire the operation -- mirrors the
      // bash spec's `sleep 2`.
      await sleep(2000);
      try {
        await steve.op("v1.6/RemoteStartTransaction", {
          chargePointSelectList: steve.cpSelect(cpId),
          connectorId: "1",
          idTag: "CERT-TAG-1",
          chargingProfilePk: "",
        });
      } catch (err) {
        // Mirror the bash spec's `|| true`: a failed queue POST doesn't
        // abort drive() -- assert() below fails loudly on its own if the
        // request never reached the CP.
        warnOpFailed("RemoteStartTransaction", err);
      }
      return { baselineTxPk };
    },
    async assert({ cpId, frames, rec, db, driveState }) {
      assertReceived(
        rec,
        frames,
        "RemoteStartTransaction",
        "RemoteStartTransaction.req received",
      );
      // uniqueId-correlated: pairs THIS RemoteStartTransaction CALL to ITS
      // OWN CALLRESULT by OCPP-J uniqueId, not the next "Sent: [3,...]"
      // line in the log -- see ocpp.ts's findResponseFor.
      assertResponseStatus(
        rec,
        frames,
        "RemoteStartTransaction",
        "Rejected",
        "RemoteStartTransaction rejected",
        { direction: "received" },
      );
      assertNotSent(
        rec,
        frames,
        "StartTransaction",
        "sent",
        "no StartTransaction sent",
      );

      const after = await db.latestTxPk(cpId);
      assertEq(
        rec,
        after,
        driveState.baselineTxPk,
        `DB: no new transaction row created for ${cpId}`,
      );
    },
  };

// ---------------------------------------------------------------------------
// TC_028 Remote Stop -- Rejected. Session charging when RemoteStopTransaction
// arrives; scenario's pre-armed override rejects it; charging continues for a
// few seconds, then the CP stops the session locally.
// ---------------------------------------------------------------------------

interface RemoteStopRejectedDriveState {
  txPk: string;
}

export const tc028RemoteStopRejectedSpec: ScenarioSpec<RemoteStopRejectedDriveState> =
  {
    templateId: "cert16-tc028-remote-stop-rejected",
    description:
      "TC_028 Remote Stop — Rejected: CSMS RemoteStopTransaction rejected mid-charge; CP stops locally afterward.",
    connector: 1,
    bootWaitSecs: 4,
    holdSecs: 20,
    async drive({ cpId, db, steve }): Promise<RemoteStopRejectedDriveState> {
      // Bind to the ACTIVE transaction CERT028's own StartTransaction
      // created, not db.latestTxPk's "newest row regardless of tag/state"
      // -- on a reused charge point that could silently pick up a stale
      // closed transaction from an earlier run instead. Mirrors the bash
      // spec's `db_wait_active_tx_pk ... || true`: waitActiveTxPk rejects
      // (fail-hard) on timeout, so catch it here and continue with an
      // empty txPk, same as the bash `|| true` swallowing a timeout.
      let txPk = "";
      try {
        txPk = await db.waitActiveTxPk(cpId, "CERT028", 15);
      } catch (err) {
        warnOpFailed("db_wait_active_tx_pk(CERT028)", err);
      }
      if (txPk) {
        try {
          await steve.op("v1.6/RemoteStopTransaction", {
            chargePointSelectList: steve.cpSelect(cpId),
            transactionId: txPk,
          });
        } catch (err) {
          warnOpFailed("RemoteStopTransaction", err);
        }
      }
      return { txPk };
    },
    async assert({ frames, lines, rec, db, driveState }) {
      assertLineMatches(
        rec,
        lines,
        /Sent: \[2,.*"StartTransaction".*"idTag":"CERT028"/,
        "StartTransaction sent with idTag CERT028",
      );
      assertResponseStatus(
        rec,
        frames,
        "RemoteStopTransaction",
        "Rejected",
        "RemoteStopTransaction rejected",
      );
      assertLineMatches(
        rec,
        lines,
        /Sent: \[2,.*"StopTransaction"/,
        "StopTransaction eventually sent (local stop after rejection, charging continued in between)",
      );

      if (!driveState.txPk) {
        rec.fail(
          "DB: transaction is closed (stop_timestamp set)",
          "no active transaction found for CERT028",
        );
        return;
      }
      assertNonEmpty(
        rec,
        await db.scalar(
          `SELECT stop_timestamp FROM transaction WHERE transaction_pk=${driveState.txPk};`,
        ),
        "DB: transaction is closed (stop_timestamp set)",
      );
    },
  };

// ---------------------------------------------------------------------------
// TC_054 Trigger Message -- CSMS sends TriggerMessage requesting a message
// type; CP answers Accepted and sends the requested message (Heartbeat here).
// ---------------------------------------------------------------------------

export const tc054TriggerMessageSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc054-trigger-message",
  description:
    "TC_054 Trigger Message: TriggerMessage(Heartbeat) accepted, CP sends the requested Heartbeat.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/TriggerMessage", {
        chargePointSelectList: steve.cpSelect(cpId),
        triggerMessage: "Heartbeat",
        connectorId: "",
      });
    } catch (err) {
      warnOpFailed("TriggerMessage", err);
    }
  },
  assert({ frames, lines, rec }) {
    assertReceived(
      rec,
      frames,
      "TriggerMessage",
      "TriggerMessage.req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "TriggerMessage",
      "Accepted",
      "TriggerMessage accepted",
    );
    // assertLineAfter (not a first-match order check): a periodic Heartbeat
    // unrelated to this TriggerMessage could land anywhere in the log and
    // either mask a real failure (an earlier Heartbeat trivially satisfies
    // first-match order) or, on a slow run, not exist yet at a fixed
    // check position. Confirm a Heartbeat appears strictly after the
    // (last) TriggerMessage.req line instead.
    assertLineAfter(
      rec,
      lines,
      /Received: \[2,.*"TriggerMessage"/,
      /Sent: \[2,.*"Heartbeat"/,
      "requested Heartbeat sent after TriggerMessage",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_055 Trigger Message -- Rejected. Scenario pre-arms a Rejected response
// override; CP answers Rejected and sends nothing.
// ---------------------------------------------------------------------------

export const tc055TriggerMessageRejectedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc055-trigger-message-rejected",
  description:
    "TC_055 Trigger Message — Rejected: pre-armed override, CP sends nothing.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/TriggerMessage", {
        chargePointSelectList: steve.cpSelect(cpId),
        triggerMessage: "Heartbeat",
        connectorId: "",
      });
    } catch (err) {
      warnOpFailed("TriggerMessage", err);
    }
  },
  assert({ frames, lines, rec }) {
    assertReceived(
      rec,
      frames,
      "TriggerMessage",
      "TriggerMessage.req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "TriggerMessage",
      "Rejected",
      "TriggerMessage rejected",
    );
    assertNoLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"Heartbeat"/,
      "no Heartbeat sent (rejected, nothing triggered)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_056 Central Smart Charging -- TxDefaultProfile. Charging session runs;
// CSMS sends SetChargingProfile (TxDefaultProfile, connector 1); CP stores
// and applies it, then the scenario stops the transaction.
// ---------------------------------------------------------------------------

interface TxDefaultProfileDriveState {
  txPk: string;
}

export const tc056SmartChargingTxDefaultSpec: ScenarioSpec<TxDefaultProfileDriveState> =
  {
    templateId: "cert16-tc056-central-smart-charging-txdefault",
    description:
      "TC_056 Central Smart Charging (TxDefaultProfile): applied by the CP; session completes.",
    connector: 1,
    bootWaitSecs: 4,
    // tx-start settle(3s) + csmsCallTrigger + 10s delay-before-stop + tail.
    holdSecs: 25,
    async drive({ cpId, db, steve }): Promise<TxDefaultProfileDriveState> {
      await sleep(3000);
      const txPk = await db.latestTxPk(cpId);
      try {
        await steve.op("v1.6/SetChargingProfile", {
          chargePointSelectList: steve.cpSelect(cpId),
          chargingProfilePk: "1",
          connectorId: "1",
          transactionId: "",
        });
      } catch (err) {
        warnOpFailed("SetChargingProfile", err);
      }
      return { txPk };
    },
    async assert({ cpId, frames, lines, rec, db, driveState }) {
      assertLineMatches(
        rec,
        lines,
        /Sent: \[2,.*"StartTransaction".*"idTag":"CERT056"/,
        "StartTransaction sent with idTag CERT056",
      );
      assertResponseStatus(
        rec,
        frames,
        "SetChargingProfile",
        "Accepted",
        "SetChargingProfile (TxDefaultProfile) accepted",
      );
      assertLineMatches(
        rec,
        lines,
        /Applied charging profile #1/,
        "CP applied the TxDefaultProfile",
      );
      assertLineMatches(
        rec,
        lines,
        /Sent: \[2,.*"StopTransaction"/,
        "StopTransaction eventually sent",
      );

      // Bash: `local tx_pk="${TX_PK:-$(db_latest_tx_pk "$CP_ID")}"` -- use
      // drive()'s captured pk if non-empty, else fall back to a fresh
      // lookup (defensive: TX_PK could be empty if drive() raced the DB
      // write before the profile-set op).
      const txPk = driveState.txPk || (await db.latestTxPk(cpId));
      if (!txPk) {
        rec.fail(
          "DB: transaction is closed (stop_timestamp set)",
          "no transaction found",
        );
        return;
      }
      assertNonEmpty(
        rec,
        await db.scalar(
          `SELECT stop_timestamp FROM transaction WHERE transaction_pk=${txPk};`,
        ),
        "DB: transaction is closed (stop_timestamp set)",
      );
    },
  };

// ---------------------------------------------------------------------------
// TC_057 Central Smart Charging -- TxProfile. Charging session runs; CSMS
// sends SetChargingProfile (TxProfile, for the running transaction); CP
// stores and applies it, then the scenario stops the transaction.
// ---------------------------------------------------------------------------

interface TxProfileDriveState {
  txPk: string;
}

export const tc057SmartChargingTxProfileSpec: ScenarioSpec<TxProfileDriveState> =
  {
    templateId: "cert16-tc057-central-smart-charging-txprofile",
    description:
      "TC_057 Central Smart Charging (TxProfile): applied by the CP to the running transaction; session completes.",
    connector: 1,
    bootWaitSecs: 4,
    holdSecs: 25,
    async drive({ cpId, db, steve }): Promise<TxProfileDriveState> {
      // Bind to the ACTIVE transaction CERT057's own StartTransaction
      // created, not db.latestTxPk's "newest row regardless of tag/state"
      // -- on a reused charge point that could silently pick up a stale
      // closed transaction from an earlier run instead (and the TxProfile
      // is only meaningful attached to the actual running transaction).
      let txPk = "";
      try {
        txPk = await db.waitActiveTxPk(cpId, "CERT057", 15);
      } catch (err) {
        warnOpFailed("db_wait_active_tx_pk(CERT057)", err);
      }
      try {
        await steve.op("v1.6/SetChargingProfile", {
          chargePointSelectList: steve.cpSelect(cpId),
          chargingProfilePk: "2",
          connectorId: "1",
          transactionId: txPk,
        });
      } catch (err) {
        warnOpFailed("SetChargingProfile", err);
      }
      return { txPk };
    },
    async assert({ frames, lines, rec, db, driveState }) {
      assertLineMatches(
        rec,
        lines,
        /Sent: \[2,.*"StartTransaction".*"idTag":"CERT057"/,
        "StartTransaction sent with idTag CERT057",
      );
      assertResponseStatus(
        rec,
        frames,
        "SetChargingProfile",
        "Accepted",
        "SetChargingProfile (TxProfile) accepted",
      );
      assertLineMatches(
        rec,
        lines,
        /Applied charging profile #2/,
        "CP applied the TxProfile",
      );
      assertLineMatches(
        rec,
        lines,
        /Sent: \[2,.*"StopTransaction"/,
        "StopTransaction eventually sent",
      );

      if (!driveState.txPk) {
        rec.fail(
          "DB: transaction is closed (stop_timestamp set)",
          "no active transaction found for CERT057",
        );
        return;
      }
      assertNonEmpty(
        rec,
        await db.scalar(
          `SELECT stop_timestamp FROM transaction WHERE transaction_pk=${driveState.txPk};`,
        ),
        "DB: transaction is closed (stop_timestamp set)",
      );
    },
  };

// ---------------------------------------------------------------------------
// TC_059 Remote Start with Charging Profile -- CSMS sends
// RemoteStartTransaction with an attached TxProfile (chargingProfilePk=2,
// the only purpose SteVe will attach to this op). Per OCPP 5.11 a Core-only
// CP may accept the start but not store/apply the profile -- that's the
// load-bearing assertion here.
// ---------------------------------------------------------------------------

export const tc059RemoteStartWithProfileSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc059-remote-start-with-profile",
  description:
    "TC_059 Remote Start with Charging Profile: accepted, but the attached TxProfile is NOT applied (Core CP).",
  connector: 1,
  bootWaitSecs: 4,
  // meter-auto blocks 30s before tx-stop + tail.
  holdSecs: 40,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/RemoteStartTransaction", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        idTag: "CERT-TAG-1",
        chargingProfilePk: "2",
      });
    } catch (err) {
      warnOpFailed("RemoteStartTransaction", err);
    }
  },
  async assert({ cpId, frames, lines, rec, db }) {
    assertResponseStatus(
      rec,
      frames,
      "RemoteStartTransaction",
      "Accepted",
      "RemoteStartTransaction (with attached TxProfile) accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction"/,
      "StartTransaction sent",
    );
    // Narrowed to profile #2 specifically (the log's actual format is
    // "Applied charging profile #<id> to connector <n>", confirmed against
    // SmartChargingHandlers.ts) -- a bare 'Applied charging profile' would
    // also fail this scenario on an unrelated profile (e.g. #1 from
    // another spec's leftover state) being applied, which isn't what this
    // assertion is about. Literal copied verbatim from the bash spec.
    assertNoLineMatches(
      rec,
      lines,
      /Applied charging profile #2 to connector/,
      "attached profile #2 is accepted but NOT stored/applied (Core CP may ignore SmartCharging profiles per OCPP 5.11)",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StopTransaction"/,
      "StopTransaction eventually sent",
    );

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        "DB: transaction is closed (stop_timestamp set)",
        "no transaction found",
      );
      return;
    }
    assertNonEmpty(
      rec,
      await db.scalar(
        `SELECT stop_timestamp FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "DB: transaction is closed (stop_timestamp set)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_066 Get Composite Schedule -- SetChargingProfile then
// GetCompositeSchedule in sequence (tests dual-park re-entry in the scenario
// engine). Both must be accepted; the returned schedule should reflect the
// applied profile.
// ---------------------------------------------------------------------------

export const tc066GetCompositeScheduleSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc066-get-composite-schedule",
  description:
    "TC_066 Get Composite Schedule: SetChargingProfile then GetCompositeSchedule, both accepted, schedule reflects the profile.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 15,
  async drive({ cpId, sim, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/SetChargingProfile", {
        chargePointSelectList: steve.cpSelect(cpId),
        chargingProfilePk: "1",
        connectorId: "1",
        transactionId: "",
      });
    } catch (err) {
      warnOpFailed("SetChargingProfile", err);
    }

    // steve_op only confirms SetChargingProfile was QUEUED -- a fixed sleep
    // here isn't a completion barrier. Wait for the CP's own confirmation
    // that it actually applied the profile (the log literal is
    // SmartChargingHandlers.ts's "Applied charging profile #<id> to
    // connector <n>") before requesting the composite schedule, so a
    // slower host can't race GetCompositeSchedule ahead of the profile
    // actually landing -- ported from the bash spec's sim_wait_log barrier.
    try {
      await sim.waitForLine(/Applied charging profile #1/, 10_000);
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: did not see 'Applied charging profile #1' within 10s -- proceeding anyway, assert() will likely fail (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
    }

    try {
      await steve.op("v1.6/GetCompositeSchedule", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        durationInSeconds: "600",
        chargingRateUnit: "W",
      });
    } catch (err) {
      warnOpFailed("GetCompositeSchedule", err);
    }
  },
  assert({ frames, lines, rec }) {
    assertResponseStatus(
      rec,
      frames,
      "SetChargingProfile",
      "Accepted",
      "SetChargingProfile accepted",
    );
    assertResponseStatus(
      rec,
      frames,
      "GetCompositeSchedule",
      "Accepted",
      "GetCompositeSchedule accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[3,.*"chargingSchedule".*"limit":11000/,
      "returned schedule reflects the applied profile's period (limit 11000)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_067 Clear Charging Profile -- CSMS sends SetChargingProfile (stored),
// then ClearChargingProfile; CP clears the profile and confirms Accepted.
// ---------------------------------------------------------------------------

export const tc067ClearChargingProfileSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc067-clear-charging-profile",
  description:
    "TC_067 Clear Charging Profile: SetChargingProfile then ClearChargingProfile, both accepted.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 15,
  async drive({ cpId, sim, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/SetChargingProfile", {
        chargePointSelectList: steve.cpSelect(cpId),
        chargingProfilePk: "1",
        connectorId: "1",
        transactionId: "",
      });
    } catch (err) {
      warnOpFailed("SetChargingProfile", err);
    }

    // Same completion-barrier rationale as TC_066 -- wait for the CP's own
    // "applied" confirmation before clearing it, so ClearChargingProfile
    // can't race ahead of the profile actually being stored.
    try {
      await sim.waitForLine(/Applied charging profile #1/, 10_000);
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: did not see 'Applied charging profile #1' within 10s -- proceeding anyway, assert() will likely fail (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
    }

    try {
      await steve.op("v1.6/ClearChargingProfile", {
        chargePointSelectList: steve.cpSelect(cpId),
        chargingProfilePk: "1",
      });
    } catch (err) {
      warnOpFailed("ClearChargingProfile", err);
    }
  },
  assert({ frames, lines, rec }) {
    assertResponseStatus(
      rec,
      frames,
      "SetChargingProfile",
      "Accepted",
      "SetChargingProfile accepted",
    );
    assertResponseStatus(
      rec,
      frames,
      "ClearChargingProfile",
      "Accepted",
      "ClearChargingProfile accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Cleared.*profile/,
      "CP logged clearing the stored profile",
    );
  },
};

// See specs/core.ts's CORE_SPECS comment: ScenarioSpec<D> is effectively
// invariant in D, so a single array holding specs with different
// driveState types needs `any` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REMOTETRIGGER_SMARTCHARGING_SPECS: ScenarioSpec<any>[] = [
  tc010RemoteStartSpec,
  tc011RemoteStartStopSpec,
  tc012RemoteStopSpec,
  tc026RemoteStartRejectedSpec,
  tc028RemoteStopRejectedSpec,
  tc054TriggerMessageSpec,
  tc055TriggerMessageRejectedSpec,
  tc056SmartChargingTxDefaultSpec,
  tc057SmartChargingTxProfileSpec,
  tc059RemoteStartWithProfileSpec,
  tc066GetCompositeScheduleSpec,
  tc067ClearChargingProfileSpec,
];
