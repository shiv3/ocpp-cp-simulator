/**
 * specs/authlist-reservation.ts -- typed port of the "LocalAuthList +
 * Reservation" bash specs (scripts/steve-verify/specs/cert16-{tc042(x2),
 * tc043(x4),reservation-basic,tc048(x4),tc051,tc052}-*.spec.sh), mirroring
 * run-all.sh's AUTHLIST_RESERVATION array exactly (13 scenarios). Each spec
 * asserts AT LEAST what its bash predecessor asserted; CALLRESULT status
 * checks are upgraded to uniqueId-paired correlation (assertResponseStatus)
 * instead of the bash version's log-window grep.
 */

import {
  assertEq,
  assertLineAfter,
  assertLineMatches,
  assertLineOrder,
  assertNonEmpty,
  assertReceived,
  assertResponseStatus,
  assertSent,
} from "../assert";
import type { ScenarioSpec } from "../spec-types";
import {
  defaultSteveConfig,
  reservationExpirySoon,
  SteveUiOps,
  waitForCondition,
} from "../steve";
import { sleep } from "../util";

function warnOpFailed(op: string, err: unknown): void {
  process.stderr.write(
    `[runner] WARN: steve_op ${op} failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

// ---------------------------------------------------------------------------
// TC_042.1 Get Local List Version -- Not Supported. Local list disabled via
// the scenario template's configSet; CP must answer listVersion -1.
// ---------------------------------------------------------------------------

export const tc0421GetLocalListVersionNotSupportedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc042-1-get-local-list-version-not-supported",
  description:
    "TC_042.1 GetLocalListVersion -> listVersion -1 (local list disabled).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/GetLocalListVersion", {
        chargePointSelectList: steve.cpSelect(cpId),
      });
    } catch (err) {
      warnOpFailed("GetLocalListVersion", err);
    }
  },
  assert({ lines, rec }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"GetLocalListVersion"/,
      "GetLocalListVersion.req received",
    );
    // No "status" field on this CALLRESULT (just {"listVersion":-1}), so
    // assertResponseStatus doesn't apply -- this run has exactly one
    // call/response pair, so a direct line match is simple and honest
    // (matches the bash spec's own reasoning).
    assertLineMatches(
      rec,
      lines,
      /"listVersion":-1/,
      "listVersion -1 returned (local list disabled)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_042.2 Get Local List Version -- Empty. Local list enabled via configSet
// on a fresh CP; CP must answer listVersion 0.
// ---------------------------------------------------------------------------

export const tc0422GetLocalListVersionEmptySpec: ScenarioSpec<void> = {
  templateId: "cert16-tc042-2-get-local-list-version-empty",
  description:
    "TC_042.2 GetLocalListVersion -> listVersion 0 (local list enabled, empty).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  // NOTE (ported from the bash spec, a reviewed/declined-restructure
  // decision -- see .superpowers/sdd/progress.md's "tc042-2 restructure
  // (fresh-process in-memory list)"): version 0 holds regardless of run
  // order. sim.ts's startSim() launches a FRESH simulator container per
  // scenario, and LocalAuthListManager's list/version live only in that
  // process's memory (src/cp/domain/auth/LocalAuthList.ts), so a prior
  // SendLocalList run against the same cpId (even earlier in the same
  // group sweep) leaves nothing behind here. Do not "fix" this by
  // resetting/isolating state -- there's no cross-run state to reset.
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/GetLocalListVersion", {
        chargePointSelectList: steve.cpSelect(cpId),
      });
    } catch (err) {
      warnOpFailed("GetLocalListVersion", err);
    }
  },
  assert({ lines, rec }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"GetLocalListVersion"/,
      "GetLocalListVersion.req received",
    );
    assertLineMatches(
      rec,
      lines,
      /"listVersion":0/,
      "listVersion 0 returned (local list enabled, empty)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_043.1 Send Local List -- Not Supported.
// ---------------------------------------------------------------------------

export const tc0431SendLocalListNotSupportedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc043-1-send-local-list-not-supported",
  description: "TC_043.1 SendLocalList -> NotSupported (local list disabled).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/SendLocalList", {
        chargePointSelectList: steve.cpSelect(cpId),
        listVersion: "1",
        updateType: "FULL",
        addUpdateList: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("SendLocalList", err);
    }
  },
  assert({ frames, rec }) {
    assertReceived(rec, frames, "SendLocalList", "SendLocalList.req received");
    assertResponseStatus(
      rec,
      frames,
      "SendLocalList",
      "NotSupported",
      "SendLocalList rejected as NotSupported (local list disabled)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_043.3 Send Local List -- Failed (pre-armed responseOverride).
// ---------------------------------------------------------------------------

export const tc0433SendLocalListFailedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc043-3-send-local-list-failed",
  description: "TC_043.3 SendLocalList -> Failed (pre-armed override).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/SendLocalList", {
        chargePointSelectList: steve.cpSelect(cpId),
        listVersion: "1",
        updateType: "FULL",
        addUpdateList: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("SendLocalList", err);
    }
  },
  assert({ frames, rec }) {
    assertReceived(rec, frames, "SendLocalList", "SendLocalList.req received");
    assertResponseStatus(
      rec,
      frames,
      "SendLocalList",
      "Failed",
      "SendLocalList rejected as Failed (pre-armed override)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_043.4 Send Local List -- Full Update.
// ---------------------------------------------------------------------------

export const tc0434SendLocalListFullSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc043-4-send-local-list-full",
  description: "TC_043.4 SendLocalList(Full) -> Accepted.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/SendLocalList", {
        chargePointSelectList: steve.cpSelect(cpId),
        listVersion: "1",
        updateType: "FULL",
        addUpdateList: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("SendLocalList", err);
    }
  },
  assert({ frames, lines, rec }) {
    // Known SteVe quirk (confirmed live, ported from the bash spec's note):
    // a Full update sends the CP its *entire* known ocpp_tag table
    // regardless of which single tag is passed in addUpdateList -- only
    // Differential respects the single selection. Not asserting an exact
    // entry count here for that reason.
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"SendLocalList".*"updateType":"Full"/,
      "SendLocalList.req received with updateType Full",
    );
    assertResponseStatus(
      rec,
      frames,
      "SendLocalList",
      "Accepted",
      "SendLocalList (Full) accepted",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_043.5 Send Local List -- Differential Update (Full then Differential).
// ---------------------------------------------------------------------------

export const tc0435SendLocalListDifferentialSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc043-5-send-local-list-differential",
  description: "TC_043.5 SendLocalList Full then Differential, both Accepted.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 18,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/SendLocalList", {
        chargePointSelectList: steve.cpSelect(cpId),
        listVersion: "1",
        updateType: "FULL",
        addUpdateList: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("SendLocalList (Full)", err);
    }
    await sleep(3000);
    try {
      await steve.op("v1.6/SendLocalList", {
        chargePointSelectList: steve.cpSelect(cpId),
        listVersion: "2",
        updateType: "DIFFERENTIAL",
        addUpdateList: "CERT-TAG-2",
      });
    } catch (err) {
      warnOpFailed("SendLocalList (Differential)", err);
    }
  },
  assert({ frames, lines, rec }) {
    assertLineOrder(
      rec,
      lines,
      /Received: \[2,.*"SendLocalList".*"updateType":"Full"/,
      /Received: \[2,.*"SendLocalList".*"updateType":"Differential"/,
      "Full update precedes Differential update",
    );
    assertResponseStatus(
      rec,
      frames,
      "SendLocalList",
      "Accepted",
      "SendLocalList (Full) accepted",
      { occurrence: 0 },
    );
    // assertResponseStatus's occurrence index picks out the SECOND
    // (Differential) Received CALL for SendLocalList by position, then
    // pairs it to ITS OWN CALLRESULT by uniqueId -- upgrading the bash
    // predecessor's check_response_status_after (anchored-then-windowed
    // grep) to real per-exchange correlation.
    assertResponseStatus(
      rec,
      frames,
      "SendLocalList",
      "Accepted",
      "SendLocalList (Differential) accepted",
      { occurrence: 1 },
    );
    assertLineMatches(
      rec,
      lines,
      /"listVersion":2,"localAuthorizationList":\[\{"idTag":"CERT-TAG-2"/,
      "Differential update carries only the selected entry",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_046 Reservation (Basic).
// ---------------------------------------------------------------------------

export const reservationBasicSpec: ScenarioSpec<void> = {
  templateId: "cert16-reservation-basic",
  description:
    "TC_046 Reservation (Basic): ReserveNow accepted; reserved idTag arrival starts a tx (hardcoded CERT-RES01), charges, stops.",
  connector: 1,
  bootWaitSecs: 4,
  // settle(2) + delay-arrival(2) + bounded meter block(30) + tail.
  holdSecs: 45,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/ReserveNow", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        expiry: reservationExpirySoon(),
        idTag: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("ReserveNow", err);
    }
  },
  async assert({ cpId, frames, lines, rec, db }) {
    assertReceived(rec, frames, "ReserveNow", "ReserveNow.req received");
    assertResponseStatus(
      rec,
      frames,
      "ReserveNow",
      "Accepted",
      "ReserveNow accepted",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction".*"idTag":"CERT-RES01"/,
      "StartTransaction sent with the scenario's hardcoded idTag CERT-RES01 (not the ReserveNow idTag)",
    );
    assertSent(rec, frames, "StopTransaction", "StopTransaction sent");

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        `DB: transaction row exists for ${cpId}`,
        "no transaction found",
      );
      return;
    }
    rec.pass(`DB: transaction row exists for ${cpId} (pk=${txPk})`);
    assertEq(
      rec,
      await db.txIdTag(txPk),
      "CERT-RES01",
      "DB: id_tag is CERT-RES01",
    );
    assertNonEmpty(
      rec,
      await db.txStopTimestamp(txPk),
      "DB: transaction is closed (stop_timestamp set)",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_048.1 ReserveNow -- Faulted.
// ---------------------------------------------------------------------------

export const tc0481ReserveNowFaultedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc048-1-reserve-now-faulted",
  description:
    "TC_048.1 ReserveNow -> Faulted (connector forced Faulted); resets to Available afterward.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/ReserveNow", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        expiry: reservationExpirySoon(),
        idTag: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("ReserveNow", err);
    }
  },
  assert({ frames, lines, rec }) {
    // Field order on the wire is errorCode before status (confirmed live on
    // TC_024's identical StatusNotification node type), so match them
    // independently rather than assuming an order.
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"errorCode":"InternalError".*"status":"Faulted"/,
      "connector forced Faulted before ReserveNow",
    );
    assertResponseStatus(
      rec,
      frames,
      "ReserveNow",
      "Faulted",
      "ReserveNow rejected as Faulted",
    );
    // assertLineAfter (not assertLineOrder): the connector's automatic
    // post-boot StatusNotification(Available) always precedes ReserveNow
    // trivially, so a first-occurrence order check would pass even without
    // a real post-ReserveNow reset. Confirm Available appears strictly
    // after the (last) ReserveNow exchange instead.
    assertLineAfter(
      rec,
      lines,
      /Received: \[2,.*"ReserveNow"/,
      /Sent: \[2,.*"StatusNotification".*"status":"Available"/,
      "reset to Available follows the ReserveNow exchange",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_048.2 ReserveNow -- Occupied.
// ---------------------------------------------------------------------------

export const tc0482ReserveNowOccupiedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc048-2-reserve-now-occupied",
  description:
    "TC_048.2 ReserveNow -> Occupied (connector plugged in); plugs out and resets to Available afterward.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/ReserveNow", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        expiry: reservationExpirySoon(),
        idTag: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("ReserveNow", err);
    }
  },
  assert({ frames, lines, rec }) {
    assertLineOrder(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"status":"Preparing"/,
      /Received: \[2,.*"ReserveNow"/,
      "connector Preparing before ReserveNow",
    );
    assertResponseStatus(
      rec,
      frames,
      "ReserveNow",
      "Occupied",
      "ReserveNow rejected as Occupied",
    );
    assertLineAfter(
      rec,
      lines,
      /Received: \[2,.*"ReserveNow"/,
      /Sent: \[2,.*"StatusNotification".*"status":"Available"/,
      "plug-out and reset to Available follow the ReserveNow exchange",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_048.3 ReserveNow -- Unavailable.
// ---------------------------------------------------------------------------

export const tc0483ReserveNowUnavailableSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc048-3-reserve-now-unavailable",
  description:
    "TC_048.3 ReserveNow -> Unavailable (connector forced Unavailable); resets to Available afterward.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/ReserveNow", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        expiry: reservationExpirySoon(),
        idTag: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("ReserveNow", err);
    }
  },
  assert({ frames, lines, rec }) {
    assertLineOrder(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"status":"Unavailable"/,
      /Received: \[2,.*"ReserveNow"/,
      "connector Unavailable before ReserveNow",
    );
    assertResponseStatus(
      rec,
      frames,
      "ReserveNow",
      "Unavailable",
      "ReserveNow rejected as Unavailable",
    );
    assertLineAfter(
      rec,
      lines,
      /Received: \[2,.*"ReserveNow"/,
      /Sent: \[2,.*"StatusNotification".*"status":"Available"/,
      "reset to Available follows the ReserveNow exchange",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_048.4 ReserveNow -- Rejected.
// ---------------------------------------------------------------------------

export const tc0484ReserveNowRejectedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc048-4-reserve-now-rejected",
  description:
    "TC_048.4 ReserveNow -> Rejected (CP configured to not accept reservations).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/ReserveNow", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
        expiry: reservationExpirySoon(),
        idTag: "CERT-TAG-1",
      });
    } catch (err) {
      warnOpFailed("ReserveNow", err);
    }
  },
  assert({ frames, rec }) {
    assertReceived(rec, frames, "ReserveNow", "ReserveNow.req received");
    assertResponseStatus(
      rec,
      frames,
      "ReserveNow",
      "Rejected",
      "ReserveNow rejected",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_051 Cancel Reservation (Accepted).
// ---------------------------------------------------------------------------

interface CancelReservationDriveState {
  reservationPk: string;
}

export const tc051CancelReservationSpec: ScenarioSpec<CancelReservationDriveState> =
  {
    templateId: "cert16-tc051-cancel-reservation",
    description:
      "TC_051 Cancel Reservation: ReserveNow then CancelReservation for the reservation it just created, both Accepted.",
    connector: 1,
    bootWaitSecs: 4,
    holdSecs: 20,
    async drive({ cpId, db, steve }): Promise<CancelReservationDriveState> {
      await sleep(2000);
      try {
        await steve.op("v1.6/ReserveNow", {
          chargePointSelectList: steve.cpSelect(cpId),
          connectorId: "1",
          expiry: reservationExpirySoon(),
          idTag: "CERT-TAG-1",
        });
      } catch (err) {
        warnOpFailed("ReserveNow", err);
      }

      // steve_op only confirms ReserveNow was QUEUED, not that SteVe has
      // finished writing the reservation row -- a one-shot read right after
      // queuing it can race the DB write and capture an empty/stale PK. Bound
      // the poll like the bash spec's wait_for_condition (15s/1s); a timeout
      // here throws and aborts the whole run, matching wait_for_condition's
      // `die` (fail-hard) semantics.
      const reservationPk = await waitForCondition(
        () => db.latestReservationPk(cpId),
        {
          timeoutMs: 15_000,
          intervalMs: 1_000,
          description: `reservation row for ${cpId} exists`,
        },
      );

      try {
        await steve.op("v1.6/CancelReservation", {
          chargePointSelectList: steve.cpSelect(cpId),
          reservationId: reservationPk,
        });
      } catch (err) {
        warnOpFailed("CancelReservation", err);
      }

      return { reservationPk };
    },
    async assert({ frames, rec, db, driveState }) {
      assertResponseStatus(
        rec,
        frames,
        "ReserveNow",
        "Accepted",
        "ReserveNow accepted",
      );
      assertResponseStatus(
        rec,
        frames,
        "CancelReservation",
        "Accepted",
        "CancelReservation accepted",
      );

      if (!driveState.reservationPk) {
        rec.fail(
          "DB: reservation id captured",
          "db_latest_reservation_pk returned empty",
        );
        return;
      }
      assertEq(
        rec,
        await db.reservationStatus(driveState.reservationPk),
        "CANCELLED",
        `DB: reservation ${driveState.reservationPk} is CANCELLED`,
      );
    },
  };

// ---------------------------------------------------------------------------
// TC_052 Cancel Reservation -- Rejected (nonexistent reservationId, no
// override needed -- core CancelReservationHandler answers Rejected).
// ---------------------------------------------------------------------------

export const tc052CancelReservationRejectedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc052-cancel-reservation-rejected",
  description: "TC_052 CancelReservation(reservationId=99999) -> Rejected.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId }) {
    await sleep(2000);
    // Deliberately bypasses `steve` (the ambient STEVE_DRIVER=api|ui
    // driver) and always uses the manager-UI client for THIS ONE call --
    // discovered live while verifying issue #184 Task 3's --parallel
    // groups: SteVe 3.13.0's REST CancelReservation
    // (OcppOperationsService#cancelReservation ->
    // #validateReservationId, source-verified) checks the reservationId
    // against ReservationRepository#getActiveReservationIds(chargeBoxId)
    // BEFORE ever dispatching to the CP, and 400s
    // ("This reservation is not active at this station.") without
    // sending anything on the wire for a reservationId the station
    // doesn't have active -- which is exactly this scenario's whole
    // point (an intentionally-nonexistent 99999, so the CP ITSELF must
    // answer Rejected). The manager-UI path
    // (Ocpp15Controller#postCancelReserv -> ChargePointServiceClient
    // directly) has no such pre-check and always reaches the CP -- a
    // genuine, permanent REST capability gap (not a flake), so this one
    // call site stays UI-only regardless of STEVE_DRIVER.
    const uiSteve = new SteveUiOps(defaultSteveConfig());
    try {
      await uiSteve.op("v1.6/CancelReservation", {
        chargePointSelectList: uiSteve.cpSelect(cpId),
        reservationId: "99999",
      });
    } catch (err) {
      warnOpFailed("CancelReservation", err);
    }
  },
  assert({ frames, rec }) {
    assertReceived(
      rec,
      frames,
      "CancelReservation",
      "CancelReservation.req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "CancelReservation",
      "Rejected",
      "CancelReservation rejected (nonexistent reservationId)",
    );
  },
};

// See specs/core.ts's CORE_SPECS comment: ScenarioSpec<D> is effectively
// invariant in D, so a single array holding specs with different
// driveState types needs `any` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUTHLIST_RESERVATION_SPECS: ScenarioSpec<any>[] = [
  tc0421GetLocalListVersionNotSupportedSpec,
  tc0422GetLocalListVersionEmptySpec,
  tc0431SendLocalListNotSupportedSpec,
  tc0433SendLocalListFailedSpec,
  tc0434SendLocalListFullSpec,
  tc0435SendLocalListDifferentialSpec,
  reservationBasicSpec,
  tc0481ReserveNowFaultedSpec,
  tc0482ReserveNowOccupiedSpec,
  tc0483ReserveNowUnavailableSpec,
  tc0484ReserveNowRejectedSpec,
  tc051CancelReservationSpec,
  tc052CancelReservationRejectedSpec,
];
