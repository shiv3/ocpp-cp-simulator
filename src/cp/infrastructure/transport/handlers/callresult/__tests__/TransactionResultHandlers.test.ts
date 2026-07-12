import { describe, expect, it, vi } from "vitest";
import {
  AuthorizeResultHandler,
  StartTransactionResultHandler,
  StopTransactionResultHandler,
} from "../TransactionResultHandlers";
import { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../../../../domain/types/OcppTypes";
import type { BootNotification } from "../../../../../domain/types/OcppTypes";
import { DefaultBootNotification } from "../../../../../domain/types/OcppTypes";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";

/**
 * Issue #175: during scenario-driven charging, StartTransactionResultHandler
 * / StopTransactionResultHandler independently re-drive Charging / Available
 * on the StartTransaction.conf / StopTransaction.conf CALLRESULT even when a
 * scenario's own `statusChange` node (or ChargePoint's own request-time
 * cascade, on the stop side) has already applied that exact status —
 * producing a duplicate StatusNotification.req on the wire. Verified live
 * against a real CSMS (SteVe) — see
 * .superpowers/sdd/steve-verify-results-g1.md.
 *
 * The fix is a same-status guard local to the two result handlers: skip
 * re-driving (and re-notifying) a transition the connector has already
 * applied by the time the CALLRESULT arrives. This intentionally does NOT
 * touch `ChargePoint.updateConnectorStatus` itself (that's also relied on
 * by ChangeAvailabilityHandler to *always* re-notify on an already-current
 * status — see its docstring) and does NOT touch the separate, deeper
 * duplication of Preparing (ChargePoint.startTransaction's own cascade) /
 * Finishing (ChargePoint.stopTransaction's own cascade) racing a scenario's
 * explicit nodes — that's an architecturally distinct issue, out of scope
 * for "stop result handlers from re-driving already-applied status
 * transitions".
 */

const bootNotification: BootNotification = DefaultBootNotification;

function buildChargePoint(): ChargePoint {
  const cp = new ChargePoint(
    "test-cp-175",
    bootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  // These are #175/#176 status-cascade tests, not #181 authorize-gate
  // tests — disable the (default-on) local-authorize gate so
  // startTransaction() keeps its pre-#181 fully-synchronous behavior here.
  // Tests that specifically exercise the #181 gate use their own
  // ChargePoint instance (see buildGatedChargePoint below).
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  return cp;
}

function buildContext(cp: ChargePoint): HandlerContext {
  return { chargePoint: cp, logger: new Logger() };
}

function trackConnectorStatus(cp: ChargePoint): OCPPStatus[] {
  const changes: OCPPStatus[] = [];
  cp.events.on("connectorStatusChange", (e) => changes.push(e.status));
  return changes;
}

describe("StartTransactionResultHandler (#175)", () => {
  it("skips re-driving Charging when a scenario's own statusChange node already applied it before the CALLRESULT arrived", () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;

    // Request-time: ChargePoint.startTransaction always drives Preparing.
    cp.startTransaction("CERT-TAG", 1);
    expect(connector.status).toBe(OCPPStatus.Preparing);

    // Start observing only from here — this isolates the handler's own
    // contribution from Preparing's (separate, out-of-scope) duplication.
    const changes = trackConnectorStatus(cp);

    // Simulate the scenario's own explicit "Set Charging" statusChange
    // node, which — per the real-CSMS verification — always runs before
    // the StartTransaction.conf CALLRESULT arrives (scenario continuation
    // is a synchronous/microtask hop; the CALLRESULT is a genuine round
    // trip).
    cp.updateConnectorStatus(1, OCPPStatus.Charging);
    expect(changes).toEqual([OCPPStatus.Charging]);

    // The CALLRESULT arrives afterwards and the handler tries to drive
    // the exact same transition again.
    new StartTransactionResultHandler(1).handle(
      { transactionId: 42, idTagInfo: { status: "Accepted" } },
      buildContext(cp),
    );

    // No second StatusNotification(Charging) — the handler recognized the
    // connector was already there.
    expect(changes).toEqual([OCPPStatus.Charging]);
    expect(connector.status).toBe(OCPPStatus.Charging);
    // The handler's non-status side effect (capturing the CSMS-assigned
    // transaction id) must still happen even when the status drive is
    // skipped.
    expect(connector.transaction?.id).toBe(42);
  });

  it("still drives Preparing -> Charging on Accepted when nothing else has (manual / remote-start, no scenario)", () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;
    const changes = trackConnectorStatus(cp);

    cp.startTransaction("TAG-2", 1);
    expect(changes).toEqual([OCPPStatus.Preparing]);

    new StartTransactionResultHandler(1).handle(
      { transactionId: 7, idTagInfo: { status: "Accepted" } },
      buildContext(cp),
    );

    expect(changes).toEqual([OCPPStatus.Preparing, OCPPStatus.Charging]);
    expect(connector.status).toBe(OCPPStatus.Charging);
    expect(connector.transaction?.id).toBe(7);
  });

  it("still drives Available on a rejected idTag when the connector isn't already there", () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;
    cp.startTransaction("TAG-3", 1);
    const changes = trackConnectorStatus(cp);

    new StartTransactionResultHandler(1).handle(
      { transactionId: 0, idTagInfo: { status: "Invalid" } },
      buildContext(cp),
    );

    // cleanTransaction() emits the transitional Finishing state on its own
    // (unrelated to this fix) before the handler's own Available drive.
    expect(changes).toEqual([OCPPStatus.Finishing, OCPPStatus.Available]);
    expect(connector.status).toBe(OCPPStatus.Available);
  });
});

describe("StopTransactionResultHandler (#175)", () => {
  it("skips re-driving Available when ChargePoint.stopTransaction's own request-time cascade already applied it", () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;
    cp.startTransaction("TAG-4", 1);
    cp.updateConnectorStatus(1, OCPPStatus.Charging);

    const changes = trackConnectorStatus(cp);

    // Request-time: ChargePoint.stopTransaction (autoResetToAvailable
    // defaults true) synchronously cascades Charging -> Finishing ->
    // Available *before* StopTransaction.conf can possibly arrive.
    cp.stopTransaction(1);
    expect(changes).toEqual([OCPPStatus.Finishing, OCPPStatus.Available]);
    expect(connector.status).toBe(OCPPStatus.Available);

    new StopTransactionResultHandler(1).handle(
      { idTagInfo: { status: "Accepted" } },
      buildContext(cp),
    );

    // No extra StatusNotification(Available) on top of the cascade above.
    expect(changes).toEqual([OCPPStatus.Finishing, OCPPStatus.Available]);
  });

  it("still drives Available when the connector hasn't reached it yet (defensive fallback, not a blanket skip)", () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;
    cp.startTransaction("TAG-5", 1);
    cp.updateConnectorStatus(1, OCPPStatus.Charging);
    // autoResetToAvailable is off while the stop request goes out, so the
    // request-time cascade stops at Finishing...
    connector.autoResetToAvailable = false;

    const changes = trackConnectorStatus(cp);
    cp.stopTransaction(1);
    expect(changes).toEqual([OCPPStatus.Finishing]);
    expect(connector.status).toBe(OCPPStatus.Finishing);

    // ...then gets re-enabled before the CALLRESULT arrives. The handler
    // must still be able to finish the job.
    connector.autoResetToAvailable = true;
    new StopTransactionResultHandler(1).handle(
      { idTagInfo: { status: "Accepted" } },
      buildContext(cp),
    );

    expect(changes).toEqual([OCPPStatus.Finishing, OCPPStatus.Available]);
    expect(connector.status).toBe(OCPPStatus.Available);
  });

  it("does not drive Available at all when autoResetToAvailable is disabled throughout", () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;
    connector.autoResetToAvailable = false;
    cp.startTransaction("TAG-6", 1);
    cp.updateConnectorStatus(1, OCPPStatus.Charging);

    const changes = trackConnectorStatus(cp);
    cp.stopTransaction(1);
    expect(changes).toEqual([OCPPStatus.Finishing]);

    new StopTransactionResultHandler(1).handle(
      { idTagInfo: { status: "Accepted" } },
      buildContext(cp),
    );

    expect(changes).toEqual([OCPPStatus.Finishing]);
    expect(connector.status).toBe(OCPPStatus.Finishing);
  });
});

/**
 * Issue #181: StartTransaction.conf with a non-Accepted idTagInfo.status is
 * now acted on per §4.8 `StopTransactionOnInvalidId` — default true stops
 * the transaction with reason "DeAuthorized" (delegating to
 * ChargePoint.stopTransaction, so the #175/#176 Finishing/Available
 * cascade applies exactly as a normal stop would); false leaves the
 * transaction running. Either way a `startTransactionNotAccepted` event is
 * emitted for observability.
 */
describe("StartTransactionResultHandler (#181) — StopTransactionOnInvalidId", () => {
  it("stops the transaction with reason DeAuthorized when StopTransactionOnInvalidId=true (default)", () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;
    cp.startTransaction("TAG-181-A", 1);

    const stopSpy = vi.spyOn(cp, "stopTransaction");
    const stopped: Array<{ connectorId: number; transactionId: number }> = [];
    cp.events.on("transactionStopped", (e) => stopped.push(e));
    const notAccepted: Array<{
      connectorId: number;
      status: string;
      stopped: boolean;
    }> = [];
    cp.events.on("startTransactionNotAccepted", (e) => notAccepted.push(e));

    new StartTransactionResultHandler(1).handle(
      { transactionId: 555, idTagInfo: { status: "Invalid" } },
      buildContext(cp),
    );

    // ChargePoint.stopTransaction() clears connector.transaction as part of
    // its normal cascade — the CSMS-assigned id is only observable via the
    // stopTransaction() call itself and the transactionStopped event.
    expect(stopSpy).toHaveBeenCalledWith(connector, "DeAuthorized");
    expect(stopped).toEqual([{ connectorId: 1, transactionId: 555 }]);
    expect(connector.transaction).toBeNull();
    expect(connector.status).toBe(OCPPStatus.Available);
    expect(notAccepted).toEqual([
      { connectorId: 1, status: "Invalid", stopped: true },
    ]);
  });

  it("keeps the transaction running (Charging) and only logs+emits when StopTransactionOnInvalidId=false", () => {
    const cp = buildChargePoint();
    const applyStatus = cp.configuration.applyChange(
      "StopTransactionOnInvalidId",
      "false",
    );
    expect(applyStatus).toBe("Accepted");
    const connector = cp.getConnector(1)!;
    cp.startTransaction("TAG-181-B", 1);

    const stopped: unknown[] = [];
    cp.events.on("transactionStopped", (e) => stopped.push(e));
    const notAccepted: Array<{
      connectorId: number;
      status: string;
      stopped: boolean;
    }> = [];
    cp.events.on("startTransactionNotAccepted", (e) => notAccepted.push(e));

    new StartTransactionResultHandler(1).handle(
      { transactionId: 777, idTagInfo: { status: "Expired" } },
      buildContext(cp),
    );

    expect(stopped).toEqual([]);
    expect(connector.transaction).not.toBeNull();
    expect(connector.transaction?.id).toBe(777);
    expect(connector.status).toBe(OCPPStatus.Charging);
    expect(notAccepted).toEqual([
      { connectorId: 1, status: "Expired", stopped: false },
    ]);
  });

  it("StopTransactionOnInvalidId=false does not re-drive Charging when already there (idempotent)", () => {
    const cp = buildChargePoint();
    cp.configuration.applyChange("StopTransactionOnInvalidId", "false");
    const connector = cp.getConnector(1)!;
    cp.startTransaction("TAG-181-C", 1);
    cp.updateConnectorStatus(1, OCPPStatus.Charging);

    const changes: OCPPStatus[] = [];
    cp.events.on("connectorStatusChange", (e) => changes.push(e.status));

    new StartTransactionResultHandler(1).handle(
      { transactionId: 888, idTagInfo: { status: "Blocked" } },
      buildContext(cp),
    );

    expect(changes).toEqual([]);
    expect(connector.status).toBe(OCPPStatus.Charging);
  });
});

/**
 * Issue #181: AuthorizeResultHandler now emits `authorizeResult` (tagId +
 * idTagInfo.status) so ChargePoint.authorizeAndWait can resolve. tagId
 * comes from the original Authorize.req payload the handler is
 * constructed with — OCPPMessageHandler.handleCallResult builds it
 * per-request (mirroring MeterValuesResultHandler), so `handle()` itself
 * stays pure/stateless when constructed without one.
 */
describe("AuthorizeResultHandler (#181)", () => {
  it("emits authorizeResult with the request's idTag and the response status", () => {
    const cp = buildChargePoint();
    const events: Array<{ tagId: string; status: string }> = [];
    cp.events.on("authorizeResult", (e) => events.push(e));

    new AuthorizeResultHandler({ idTag: "TAG-9" }).handle(
      { idTagInfo: { status: "Blocked" } },
      buildContext(cp),
    );

    expect(events).toEqual([{ tagId: "TAG-9", status: "Blocked" }]);
  });

  it("does not emit when constructed without a request payload", () => {
    const cp = buildChargePoint();
    const events: unknown[] = [];
    cp.events.on("authorizeResult", (e) => events.push(e));

    new AuthorizeResultHandler().handle(
      { idTagInfo: { status: "Accepted" } },
      buildContext(cp),
    );

    expect(events).toEqual([]);
  });
});
