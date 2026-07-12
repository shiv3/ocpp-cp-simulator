/**
 * specs/core.ts -- typed port of the "Core" group's bash specs
 * (scripts/steve-verify/specs/cert16-{tc001,tc003,tc004,tc005,tc013,tc014,
 * tc017,tc018,tc019(x2),tc021,tc024,tc031,tc061,tc064}-*.spec.sh), mirroring
 * run-all.sh's CORE array exactly (15 scenarios). Each spec asserts AT
 * LEAST what its bash predecessor asserted; CALLRESULT status checks are
 * upgraded to uniqueId-paired correlation (assertResponseStatus /
 * assertIdTagInfoStatus) instead of the bash version's log-window grep.
 */

import {
  assertEq,
  assertIdTagInfoStatus,
  assertLineAfter,
  assertLineMatches,
  assertLineOrder,
  assertNoLineMatches,
  assertNonEmpty,
  assertReceived,
  assertResponseStatus,
  assertSent,
} from "../assert";
import { findCall, findResponseFor } from "../ocpp";
import type { ScenarioSpec } from "../spec-types";
import { sleep } from "../util";

// ---------------------------------------------------------------------------
// TC_001 Cold Boot -- CP-only, no CSMS-side operator action.
// ---------------------------------------------------------------------------

export const tc001ColdBootSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc001-cold-boot",
  description:
    "TC_001 Cold Boot: CP re-affirms StatusNotification(Available) after boot, then idles.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 20,
  assert({ frames, lines, rec }) {
    assertSent(rec, frames, "BootNotification", "BootNotification.req sent");
    assertResponseStatus(
      rec,
      frames,
      "BootNotification",
      "Accepted",
      "BootNotification accepted",
      { direction: "sent" },
    );

    const sentAvailableOnConnector1 = frames.some(
      (f) =>
        f.kind === "call" &&
        f.direction === "sent" &&
        f.action === "StatusNotification" &&
        (f.payload as { connectorId?: number; status?: string } | null)
          ?.connectorId === 1 &&
        (f.payload as { connectorId?: number; status?: string } | null)
          ?.status === "Available",
    );
    if (sentAvailableOnConnector1) {
      rec.pass("StatusNotification(Available) sent for connector 1");
    } else {
      rec.fail(
        "StatusNotification(Available) sent for connector 1",
        "no Sent StatusNotification frame with connectorId=1, status=Available",
      );
    }

    // Prefer the structured JSON event over the bash version's free-text
    // "Scenario execution completed" grep -- see the Task 1 investigation
    // notes (.superpowers/sdd/tsr-task-1-report.md) for why it's the more
    // robust signal for scenario lifecycle specifically.
    assertLineMatches(
      rec,
      lines,
      /"event":"scenario_completed"/,
      "scenario ran to completion",
    );
    assertNoLineMatches(
      rec,
      lines,
      /blocked by the boot gate/,
      "no messages were dropped by the boot gate",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_003 Charging Session (Plug-In First) -- fully CP-driven.
// ---------------------------------------------------------------------------

export const tc003ChargingPluginFirstSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc003-charging-plugin-first",
  description:
    "TC_003 Charging Session (Plug-In First): plug in, idTag CERT003, charge, stop, plug out.",
  connector: 1,
  bootWaitSecs: 4,
  // delay-connect(2s) + delay-idtag(2s) + bounded meter block(30s) + tail.
  holdSecs: 45,
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineOrder(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"status":"Preparing"/,
      /Sent: \[2,.*"StartTransaction"/,
      "Preparing precedes StartTransaction",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction".*"idTag":"CERT003"/,
      "StartTransaction sent with idTag CERT003",
    );
    assertIdTagInfoStatus(
      rec,
      frames,
      "StartTransaction",
      "Accepted",
      "StartTransaction accepted by SteVe",
    );
    assertSent(rec, frames, "MeterValues", "MeterValues sent while charging");
    assertLineOrder(
      rec,
      lines,
      /Sent: \[2,.*"MeterValues"/,
      /Sent: \[2,.*"StopTransaction"/,
      "MeterValues precede StopTransaction",
    );
    assertSent(rec, frames, "StopTransaction", "StopTransaction sent");
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"status":"Available"/,
      "final StatusNotification(Available) sent",
    );

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
      await db.scalar(
        `SELECT id_tag FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "CERT003",
      "DB: id_tag is CERT003",
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
// TC_004 Charging Session (Identification First) -- fully CP-driven.
// ---------------------------------------------------------------------------

export const tc004ChargingIdFirstSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc004-charging-id-first",
  description:
    "TC_004 Charging Session (Identification First): idTag CERT004 before plug-in, charge, stop.",
  connector: 1,
  bootWaitSecs: 4,
  // delay-idtag(2s) + bounded meter block(30s) + tail.
  holdSecs: 40,
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction".*"idTag":"CERT004"/,
      "StartTransaction sent with idTag CERT004",
    );
    assertIdTagInfoStatus(
      rec,
      frames,
      "StartTransaction",
      "Accepted",
      "StartTransaction accepted by SteVe",
    );
    assertSent(rec, frames, "MeterValues", "MeterValues sent while charging");
    assertLineOrder(
      rec,
      lines,
      /Sent: \[2,.*"MeterValues"/,
      /Sent: \[2,.*"StopTransaction"/,
      "MeterValues precede StopTransaction",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"status":"Available"/,
      "final StatusNotification(Available) sent",
    );

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
      await db.scalar(
        `SELECT id_tag FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "CERT004",
      "DB: id_tag is CERT004",
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
// TC_005 EV Side Disconnected -- fully CP-driven.
// ---------------------------------------------------------------------------

export const tc005EvSideDisconnectSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc005-ev-side-disconnect",
  description:
    "TC_005 EV Side Disconnected: mid-charge EV-side plugout, StopTransaction reason EVDisconnected.",
  connector: 1,
  bootWaitSecs: 4,
  // bounded meter block(15s) + tail.
  holdSecs: 25,
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction".*"idTag":"CERT005"/,
      "StartTransaction sent with idTag CERT005",
    );
    assertSent(rec, frames, "MeterValues", "MeterValues sent while charging");
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StopTransaction".*"reason":"EVDisconnected"/,
      "StopTransaction sent with reason EVDisconnected",
    );

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
      await db.scalar(
        `SELECT id_tag FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "CERT005",
      "DB: id_tag is CERT005",
    );
    assertEq(
      rec,
      await db.scalar(
        `SELECT stop_reason FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "EVDisconnected",
      "DB: stop_reason is EVDisconnected",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_013 Hard Reset -- CSMS Reset(Hard) during charging.
// ---------------------------------------------------------------------------

export const tc013HardResetSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc013-hard-reset",
  description:
    "TC_013 Hard Reset: CSMS Reset(Hard) mid-charge; CP stops the tx (HardReset) and reboots (WS disconnect+reconnect).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 25,
  async drive({ cpId, steve }) {
    await sleep(3000);
    try {
      await steve.op("v1.6/Reset", {
        chargePointSelectList: steve.cpSelect(cpId),
        resetType: "HARD",
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op Reset(Hard) failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"Reset".*"type":"Hard"/,
      "Reset(Hard).req received",
    );
    // NOTE (ported from the bash spec, confirmed live): unlike Soft Reset,
    // the CP does NOT send an explicit Reset.conf CALLRESULT before
    // disconnecting on a Hard Reset -- it goes straight from "Reset request
    // received: Hard" to StopTransaction to WebSocket close. That's real
    // observed behavior, not a gap in this spec, so the disconnect/
    // reconnect/reboot sequence is asserted instead of a never-sent
    // CALLRESULT.
    assertSent(rec, frames, "StopTransaction", "StopTransaction sent");
    assertLineOrder(
      rec,
      lines,
      /Sent: \[2,.*"StopTransaction"/,
      /WebSocket closed/,
      "StopTransaction precedes the WebSocket disconnect (reboot)",
    );

    const bootCount = frames.filter(
      (f) =>
        f.kind === "call" &&
        f.direction === "sent" &&
        f.action === "BootNotification",
    ).length;
    if (bootCount >= 2) {
      rec.pass(
        `CP reconnects and sends a fresh BootNotification after the reboot (${bootCount} total)`,
      );
    } else {
      rec.fail(
        "CP reconnects and sends a fresh BootNotification after the reboot",
        `expected >=2 BootNotification.req sends (initial + post-reboot), got ${bootCount}`,
      );
    }

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        `DB: transaction row exists for ${cpId}`,
        "no transaction found",
      );
      return;
    }
    assertEq(
      rec,
      await db.scalar(
        `SELECT stop_reason FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "HardReset",
      "DB: stop_reason is HardReset",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_014 Soft Reset -- CSMS Reset(Soft) during charging.
//
// templateId/naming NOTE: a prior review suggested renaming this to
// "tc016" to follow the OCTT CSMS-side test-case document's numbering
// (README's numbering note); that suggestion was explicitly DECLINED (see
// .superpowers/sdd/progress.md's "declined w/ rationale: tc014 rename
// (CSMS-doc numbering)") -- the id/filename intentionally stays
// cert16-tc014-soft-reset. Carried forward unchanged here.
// ---------------------------------------------------------------------------

export const tc014SoftResetSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc014-soft-reset",
  description:
    "TC_014 Soft Reset: CSMS Reset(Soft) mid-charge; CP stops the tx (SoftReset) and reboots on the SAME socket.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 25,
  async drive({ cpId, steve }) {
    await sleep(3000);
    try {
      await steve.op("v1.6/Reset", {
        chargePointSelectList: steve.cpSelect(cpId),
        resetType: "SOFT",
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op Reset(Soft) failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  async assert({ cpId, frames, lines, rec, db }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"Reset".*"type":"Soft"/,
      "Reset(Soft).req received",
    );
    assertResponseStatus(rec, frames, "Reset", "Accepted", "Reset accepted", {
      direction: "received",
    });
    assertSent(rec, frames, "StopTransaction", "StopTransaction sent");
    // ChargePoint.applyRemoteReset() takes the Soft path via boot() (no
    // disconnect/reconnect -- see src/cp/domain/charge-point/ChargePoint.ts),
    // which re-sends BootNotification.req on the SAME socket -- a CP CALL,
    // so it shows up as "Sent:" here, not "Received:". Anchored strictly
    // after the Reset.req line (assertLineAfter, not assertLineOrder) so
    // the unrelated INITIAL BootNotification can't trivially satisfy this.
    assertLineAfter(
      rec,
      lines,
      /Received: \[2,.*"Reset"/,
      /Sent: \[2,.*"BootNotification"/,
      "CP sends a fresh BootNotification after Soft Reset (reboot on the same socket)",
    );

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        `DB: transaction row exists for ${cpId}`,
        "no transaction found",
      );
      return;
    }
    assertEq(
      rec,
      await db.scalar(
        `SELECT stop_reason FROM transaction WHERE transaction_pk=${txPk};`,
      ),
      "SoftReset",
      "DB: stop_reason is SoftReset",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_017 Unlock Connector (Occupied, Succeeds).
// ---------------------------------------------------------------------------

export const tc017UnlockOccupiedSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc017-unlock-occupied",
  description:
    "TC_017 Unlock Connector (Occupied, Succeeds): CSMS UnlockConnector while charging -> Unlocked; session completes normally.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 35,
  async drive({ cpId, steve }) {
    // Timing: delay(2s) -> plug-in -> preparing -> tx-start -> charging ->
    // meter-auto(maxTime 15s, BLOCKS) -> unlock pre-arm (instant) ->
    // delay(10s window) -> tx-stop. The pre-arm window for
    // UnlockConnector.req is roughly [17s, 27s] after scenario start -- land
    // the op with a single combined sleep+op (mirrors the bash spec's
    // rationale, see .superpowers/sdd/steve-verify-results-g1.md).
    await sleep(20_000);
    try {
      await steve.op("v1.6/UnlockConnector", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op UnlockConnector failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  async assert({ cpId, db, frames, rec }) {
    assertReceived(
      rec,
      frames,
      "UnlockConnector",
      "UnlockConnector.req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "UnlockConnector",
      "Unlocked",
      "UnlockConnector -> Unlocked",
    );
    assertSent(
      rec,
      frames,
      "StopTransaction",
      "StopTransaction sent (session completes normally)",
    );

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        `DB: transaction row exists for ${cpId}`,
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
// TC_018 Unlock Connector (Failure).
// ---------------------------------------------------------------------------

export const tc018UnlockFailureSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc018-unlock-failure",
  description:
    "TC_018 Unlock Connector (Failure): CSMS UnlockConnector while charging -> UnlockFailed; session STILL completes normally.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 35,
  async drive({ cpId, steve }) {
    // Same timing window as TC_017 -- see that spec for the derivation.
    await sleep(20_000);
    try {
      await steve.op("v1.6/UnlockConnector", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "1",
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op UnlockConnector failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  async assert({ cpId, db, frames, rec }) {
    assertReceived(
      rec,
      frames,
      "UnlockConnector",
      "UnlockConnector.req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "UnlockConnector",
      "UnlockFailed",
      "UnlockConnector -> UnlockFailed",
    );
    assertSent(
      rec,
      frames,
      "StopTransaction",
      "StopTransaction sent (session completes normally despite unlock failure)",
    );

    const txPk = await db.latestTxPk(cpId);
    if (!txPk) {
      rec.fail(
        `DB: transaction row exists for ${cpId}`,
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
// TC_019_1 Retrieve All Configuration Keys.
// ---------------------------------------------------------------------------

export const tc019GetConfigurationAllSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc019-get-configuration-all",
  description:
    "TC_019_1 GetConfiguration(no filter) returns every supported key.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/GetConfiguration", {
        chargePointSelectList: steve.cpSelect(cpId),
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op GetConfiguration failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  assert({ lines, rec }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"GetConfiguration".*"key":\[\]/,
      "GetConfiguration(no filter).req received",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[3,.*"configurationKey":\[{"key"/,
      "CALLRESULT returns a configurationKey list",
    );
    assertLineMatches(
      rec,
      lines,
      /"HeartbeatInterval"/,
      "response includes HeartbeatInterval",
    );
    assertLineMatches(
      rec,
      lines,
      /"SupportedFeatureProfiles"/,
      "response includes SupportedFeatureProfiles",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_019_2 Retrieve Specific Configuration Key.
// ---------------------------------------------------------------------------

export const tc019GetConfigurationKeySpec: ScenarioSpec<void> = {
  templateId: "cert16-tc019-get-configuration-key",
  description:
    "TC_019_2 GetConfiguration(HeartbeatInterval) returns just that key.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/GetConfiguration", {
        chargePointSelectList: steve.cpSelect(cpId),
        confKeyList: "HeartbeatInterval",
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op GetConfiguration failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  assert({ lines, rec }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"GetConfiguration".*"key":\["HeartbeatInterval"\]/,
      "GetConfiguration(HeartbeatInterval).req received",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[3,.*"configurationKey":\[{"key":"HeartbeatInterval"/,
      "CALLRESULT returns the HeartbeatInterval key",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_021 Change Configuration.
// ---------------------------------------------------------------------------

export const tc021ChangeConfigurationSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc021-change-configuration",
  description:
    "TC_021 ChangeConfiguration(MeterValueSampleInterval=10) accepted and applied.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/ChangeConfiguration", {
        chargePointSelectList: steve.cpSelect(cpId),
        keyType: "PREDEFINED",
        confKey: "MeterValueSampleInterval",
        customConfKey: "",
        value: "10",
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op ChangeConfiguration failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  assert({ frames, lines, rec }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"ChangeConfiguration".*"key":"MeterValueSampleInterval".*"value":"10"/,
      "ChangeConfiguration(MeterValueSampleInterval=10).req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "ChangeConfiguration",
      "Accepted",
      "ChangeConfiguration accepted",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_024 Start Charging Session -- Lock Failure.
// ---------------------------------------------------------------------------

export const tc024LockFailureSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc024-lock-failure",
  description:
    "TC_024 Lock Failure: plug in -> Faulted/ConnectorLockFailure, no transaction started, then plug out.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 12,
  assert({ lines, rec }) {
    // Field order on the wire is errorCode before status (confirmed live),
    // so match them independently rather than assuming an order.
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"errorCode":"ConnectorLockFailure".*"status":"Faulted"/,
      "StatusNotification(Faulted, ConnectorLockFailure) sent",
    );
    assertNoLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StartTransaction"/,
      "no StartTransaction sent (lock failure prevents charging)",
    );
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"StatusNotification".*"status":"Available"/,
      "final StatusNotification(Available) sent after plug-out",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_031 Unlock Connector -- Unknown Connector.
// ---------------------------------------------------------------------------

export const tc031UnlockUnknownConnectorSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc031-unlock-unknown-connector",
  description:
    "TC_031 UnlockConnector(connectorId=99) -> NotSupported (unknown connector).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 10,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/UnlockConnector", {
        chargePointSelectList: steve.cpSelect(cpId),
        connectorId: "99",
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op UnlockConnector failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  assert({ frames, lines, rec }) {
    assertLineMatches(
      rec,
      lines,
      /Received: \[2,.*"UnlockConnector".*"connectorId":99/,
      "UnlockConnector(connectorId=99).req received",
    );
    assertResponseStatus(
      rec,
      frames,
      "UnlockConnector",
      "NotSupported",
      "UnlockConnector -> NotSupported",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_061 Clear Authorization Cache.
// ---------------------------------------------------------------------------

export const tc061ClearCacheSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc061-clear-cache",
  description: "TC_061 ClearCache accepted.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 15,
  async drive({ cpId, steve }) {
    await sleep(2000);
    try {
      await steve.op("v1.6/ClearCache", {
        chargePointSelectList: steve.cpSelect(cpId),
      });
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: steve_op ClearCache failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },
  assert({ frames, rec }) {
    assertReceived(rec, frames, "ClearCache", "ClearCache.req received");
    assertResponseStatus(
      rec,
      frames,
      "ClearCache",
      "Accepted",
      "ClearCache accepted",
    );
  },
};

// ---------------------------------------------------------------------------
// TC_064 Data Transfer to Central System -- CP-initiated, unprompted.
// ---------------------------------------------------------------------------

export const tc064DataTransferSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc064-data-transfer",
  description:
    "TC_064 DataTransfer: CP sends DataTransfer.req unprompted; CSMS response status is SteVe's own policy (not asserted exactly).",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 10,
  assert({ frames, lines, rec }) {
    assertLineMatches(
      rec,
      lines,
      /Sent: \[2,.*"DataTransfer".*"vendorId":"com\.example\.cert16".*"messageId":"certTest".*"data":"hello-csms"/,
      "DataTransfer.req sent with expected vendorId/messageId/data",
    );

    const description =
      "DataTransfer.conf received (status is SteVe's own policy, not asserted)";
    const call = findCall(frames, "sent", "DataTransfer");
    if (!call) {
      rec.fail(description, "no Sent CALL found for action=DataTransfer");
      return;
    }
    const response = findResponseFor(frames, call);
    if (!response) {
      rec.fail(
        description,
        `no response frame found for uniqueId=${call.uniqueId} (DataTransfer)`,
      );
      return;
    }
    if (response.kind === "callerror") {
      rec.fail(
        description,
        `expected CALLRESULT, got CALLERROR ${response.errorCode}: ${response.errorDescription}`,
      );
      return;
    }
    const status = (response.payload as { status?: unknown } | null)?.status;
    if (
      status === "Accepted" ||
      status === "Rejected" ||
      status === "UnknownVendorId"
    ) {
      rec.pass(description);
    } else {
      rec.fail(
        description,
        `expected status in (Accepted|Rejected|UnknownVendorId), got ${String(status)}`,
      );
    }
  },
};

// ScenarioSpec<D> is effectively invariant in D (D appears in drive()'s
// return position AND assert()'s parameter position), so a single array
// holding specs with different driveState types needs `any` here, same as
// main.ts's SPECS_BY_TEMPLATE_ID registry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CORE_SPECS: ScenarioSpec<any>[] = [
  tc001ColdBootSpec,
  tc003ChargingPluginFirstSpec,
  tc004ChargingIdFirstSpec,
  tc005EvSideDisconnectSpec,
  tc013HardResetSpec,
  tc014SoftResetSpec,
  tc017UnlockOccupiedSpec,
  tc018UnlockFailureSpec,
  tc019GetConfigurationAllSpec,
  tc019GetConfigurationKeySpec,
  tc021ChangeConfigurationSpec,
  tc024LockFailureSpec,
  tc031UnlockUnknownConnectorSpec,
  tc061ClearCacheSpec,
  tc064DataTransferSpec,
];
