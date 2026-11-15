import { describe, expect, it, vi } from "vitest";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointCapabilityProfile } from "../../../domain/charge-point/CapabilityProfile";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import type { Outbox } from "../../../domain/transport/Outbox";
import { createChargePoint } from "../../../infrastructure/charge-point/createChargePoint";
import { LogLevel } from "../../../shared/Logger";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";

/**
 * #618: `capabilityProfile.statusTransitions`. Under `enforce` a connector
 * status change the OCPP 1.6 §4.9 table does not list still changes the
 * connector, but its StatusNotification is not sent, unless the write asks
 * for it with `allowInvalidTransition`. `warn` (and no profile) keep sending.
 */

function station(
  profile?: ChargePointCapabilityProfile,
  version = "OCPP-1.6J",
): ChargePoint {
  return createChargePoint(
    "engine-status-transitions",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    version,
    profile ? { capabilityProfile: profile } : {},
  );
}

function observe(cp: ChargePoint) {
  const outbox = (cp as unknown as { _outbox: Outbox })._outbox;
  const sent = vi
    .spyOn(outbox, "sendStatusNotification")
    .mockImplementation(() => undefined);
  const suppressed: ChargePointEvents["statusNotificationSuppressed"][] = [];
  const changes: OCPPStatus[] = [];
  const warnings: string[] = [];
  cp.events.on("statusNotificationSuppressed", (e) => suppressed.push(e));
  cp.events.on("connectorStatusChange", ({ status }) => changes.push(status));
  cp.logger.loggingCallback = (entry) => {
    if (entry.level === LogLevel.WARN) warnings.push(entry.message);
  };
  const statuses = () =>
    sent.mock.calls
      .filter(([connectorId]) => connectorId === 1)
      .map(([, status]) => status);
  const reset = () => {
    sent.mockClear();
    suppressed.length = 0;
    changes.length = 0;
    warnings.length = 0;
  };
  return { statuses, suppressed, changes, warnings, reset };
}

describe("statusTransitions (#618)", () => {
  it("enforce: an out-of-table change updates the connector but sends nothing", () => {
    const cp = station({ statusTransitions: "enforce" });
    expect(cp.enforcesStatusTransitions).toBe(true);
    const o = observe(cp);
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    o.reset();

    cp.updateConnectorStatus(1, OCPPStatus.Finishing); // A6: not in the table

    expect(cp.getConnector(1)!.status).toBe(OCPPStatus.Finishing);
    expect(o.statuses()).toEqual([]);
    // The local change is still announced.
    expect(o.changes).toEqual([OCPPStatus.Finishing]);
    expect(o.suppressed).toEqual([
      {
        connectorId: 1,
        from: OCPPStatus.Available,
        to: OCPPStatus.Finishing,
        reason: "invalidTransition",
      },
    ]);
    expect(o.warnings).toEqual([
      expect.stringContaining("StatusNotification not sent"),
    ]);

    // A listed transition (F1) is sent as usual.
    o.reset();
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    expect(o.statuses()).toEqual([OCPPStatus.Available]);
    expect(o.suppressed).toEqual([]);
  });

  it("enforce: allowInvalidTransition sends the change anyway", () => {
    const cp = station({ statusTransitions: "enforce" });
    const o = observe(cp);
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    o.reset();

    cp.updateConnectorStatus(1, OCPPStatus.Finishing, {
      allowInvalidTransition: true,
    });

    expect(o.statuses()).toEqual([OCPPStatus.Finishing]);
    expect(o.suppressed).toEqual([]);
    expect(o.warnings).toEqual([
      expect.stringContaining("not an expected transition"),
    ]);
  });

  it("warn (explicit or absent): an out-of-table change is sent with a warning", () => {
    for (const profile of [
      undefined,
      {},
      { statusTransitions: "warn" } as const,
    ]) {
      const cp = station(profile);
      expect(cp.enforcesStatusTransitions).toBe(false);
      const o = observe(cp);
      cp.updateConnectorStatus(1, OCPPStatus.Available);
      o.reset();

      cp.updateConnectorStatus(1, OCPPStatus.Finishing);

      expect(o.statuses()).toEqual([OCPPStatus.Finishing]);
      expect(o.suppressed).toEqual([]);
      expect(o.warnings).toEqual([
        expect.stringContaining("not an expected transition"),
      ]);
    }
  });

  it("does not apply to OCPP 2.x: the §4.9 table is 1.6 vocabulary", () => {
    const cp = station({ statusTransitions: "enforce" }, "OCPP-2.0.1");
    expect(cp.enforcesStatusTransitions).toBe(false);
  });
});
