import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { canBindBunServe } from "../../../../test/bunServe";
import { startMockCsms } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
  stationFor,
} from "./stationHarness";
import type { ChargePointCapabilityProfile } from "../../../domain/charge-point/CapabilityProfile";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { LogLevel } from "../../../shared/Logger";

/**
 * #618 strict modes on the wire: `disabledActionErrorCode` picks the
 * OCPP-J §4.2.3 code a disabled action is answered with,
 * `statusTransitions: "enforce"` keeps an OCPP 1.6 §4.9 out-of-table
 * transition off the wire, and a profile that contradicts
 * `SupportedFeatureProfiles` is logged when the 1.6J station connects.
 */
const replyTo = (id: unknown) => (f: unknown[]) =>
  (f[0] === 3 || f[0] === 4) && f[1] === id;

async function station(
  version: string,
  id: string,
  profile?: ChargePointCapabilityProfile,
) {
  const csms = startMockCsms();
  const cp = await bootedChargePoint(csms, id, version, {
    ...(profile ? { capabilityProfile: profile } : {}),
  });
  const stop = answerEverythingElse(csms, []);
  const done = async () => {
    stop();
    cp.disconnect();
    await csms.stop();
  };
  return { csms, cp, done };
}

describe.skipIf(!canBindBunServe())(
  "capability profile strict modes (#618)",
  () => {
    it("1.6J: disabledActionErrorCode NotSupported answers CALLERROR NotSupported", async () => {
      const { csms, done } = await station("OCPP-1.6J", "CP-STRICT-1", {
        disabledActions: ["ReserveNow"],
        disabledActionErrorCode: "NotSupported",
      });
      try {
        csms.send([
          2,
          "rn-1",
          "ReserveNow",
          {
            connectorId: 1,
            expiryDate: "2030-01-01T00:00:00.000Z",
            idTag: "T",
            reservationId: 1,
          },
        ]);
        const reply = await csms.waitForFrame(replyTo("rn-1"));
        expect(reply[0]).toBe(4);
        expect(reply[2]).toBe("NotSupported");
      } finally {
        await done();
      }
    });

    it("2.0.1: disabledActionErrorCode NotSupported answers CALLERROR NotSupported", async () => {
      const { csms, done } = await station("OCPP-2.0.1", "CP-STRICT-2", {
        disabledActions: ["Reset"],
        disabledActionErrorCode: "NotSupported",
      });
      try {
        csms.send([2, "r-1", "Reset", { type: "Immediate" }]);
        const reply = await csms.waitForFrame(replyTo("r-1"));
        expect(reply[0]).toBe(4);
        expect(reply[2]).toBe("NotSupported");
      } finally {
        await done();
      }
    });

    it("1.6J enforce: an out-of-table transition is not sent, a forced one is", async () => {
      const { csms, cp, done } = await station("OCPP-1.6J", "CP-STRICT-3", {
        statusTransitions: "enforce",
      });
      try {
        const suppressed: unknown[] = [];
        cp.events.on("statusNotificationSuppressed", (e) => suppressed.push(e));
        const before = callsOf(csms, "StatusNotification").length;

        cp.updateConnectorStatus(1, OCPPStatus.Finishing); // A6: suppressed
        expect(cp.getConnector(1)!.status).toBe(OCPPStatus.Finishing);
        cp.updateConnectorStatus(1, OCPPStatus.Available); // F1: sent
        cp.updateConnectorStatus(1, OCPPStatus.Finishing, {
          allowInvalidTransition: true,
        }); // A6, forced: sent
        await csms.waitForFrame(
          (f) =>
            callOf("StatusNotification")(f) &&
            (f[3] as { status?: string }).status === "Finishing",
        );

        const statuses = callsOf(csms, "StatusNotification")
          .slice(before)
          .map((f) => f[3] as { connectorId: number; status: string })
          .filter((p) => p.connectorId === 1)
          .map((p) => p.status);
        // Only the forced Finishing reached the CSMS; the boot reports may
        // still add an Available ahead of the F1 one.
        expect(statuses.filter((s) => s === "Finishing")).toEqual([
          "Finishing",
        ]);
        expect(statuses.slice(-2)).toEqual(["Available", "Finishing"]);
        expect(suppressed).toEqual([
          {
            connectorId: 1,
            from: OCPPStatus.Available,
            to: OCPPStatus.Finishing,
            reason: "invalidTransition",
          },
        ]);
      } finally {
        await done();
      }
    });

    it("1.6J: conflicts with SupportedFeatureProfiles are logged on connect, nothing is refused", async () => {
      const csms = startMockCsms();
      const cp = stationFor(csms, "CP-STRICT-4", "OCPP-1.6J", {
        capabilityProfile: {
          disabledActions: ["ReserveNow"],
          triggerMessageTargets: ["Heartbeat"],
        },
      });
      cp.configuration.setRuntimeValue("SupportedFeatureProfiles", [
        "Core",
        "Reservation",
      ]);
      const warnings: string[] = [];
      cp.logger.loggingCallback = (entry) => {
        if (entry.level === LogLevel.WARN) warnings.push(entry.message);
      };
      try {
        cp.connect();
        await csms.waitForCall("BootNotification");
        expect(warnings).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              "disables ReserveNow, but SupportedFeatureProfiles lists Reservation",
            ),
            expect.stringContaining("does not list RemoteTrigger"),
          ]),
        );
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
