import { describe, it, expect } from "bun:test";
import type {
  MeterValuesRequestV201,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";

/**
 * #335 — the OCPP 2.0.1 TransactionEvent builder used to fix `triggerReason`,
 * `stoppedReason` and `chargingState` per command, so a driven station could
 * only ever produce the handful of events the simulator itself chooses. These
 * tests pin the widened surface: a caller names the values, the wire carries
 * them verbatim, and `sampledValue.context` — computed and then dropped before
 * #335 — reaches the payload.
 */

function transactionEvent(
  eventType: TransactionEventRequestV201["eventType"],
  after = -1,
  csms?: MockCsms,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as { eventType?: string }).eventType === eventType &&
    (csms ? csms.received.indexOf(frame) > after : true);
}

function payload(frame: OcppFrame): TransactionEventRequestV201 {
  return frame[3] as TransactionEventRequestV201;
}

async function bootedChargePoint(
  csms: MockCsms,
  id: string,
  version: "OCPP-2.0.1" | "OCPP-1.6" = "OCPP-2.0.1",
): Promise<ChargePoint> {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.connect();
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-09-12T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (frame) => frame[0] === 2 && frame[2] === "StatusNotification",
  );
  return cp;
}

describe("OCPP 2.0.1 TransactionEvent width (#335)", () => {
  it("carries a caller's triggerReason / chargingState on Started and stoppedReason / triggerReason on Ended", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-WIDTH-LIFECYCLE");
    try {
      // A cable-first session: the transaction opens on plug-in, not on
      // authorization, and the EV is connected but not yet charging.
      await cp.startTransaction("TAG-335", 1, undefined, undefined, {
        triggerReason: "CablePluggedIn",
        chargingState: "EVConnected",
      });
      const started = payload(
        await csms.waitForFrame(transactionEvent("Started")),
      );
      expect(started.triggerReason).toBe("CablePluggedIn");
      expect(started.transactionInfo.chargingState).toBe("EVConnected");

      // The Started state is what the status-driven Updated event is
      // de-duplicated against: moving to Charging is a change and is sent.
      cp.updateConnectorStatus(1, OCPPStatus.Charging);
      const charging = payload(
        await csms.waitForFrame(
          transactionEvent("Updated", csms.received.length - 2, csms),
        ),
      );
      expect(charging.triggerReason).toBe("ChargingStateChanged");
      expect(charging.transactionInfo.chargingState).toBe("Charging");

      // A 2.0.1-only stop reason is sent verbatim, not mapped through the
      // 1.6 vocabulary, and the Ended trigger is the caller's.
      cp.stopTransaction(1, "Other", {
        triggerReason: "EVCommunicationLost",
        stoppedReason: "StoppedByEV",
      });
      const ended = payload(await csms.waitForFrame(transactionEvent("Ended")));
      expect(ended.triggerReason).toBe("EVCommunicationLost");
      expect(ended.transactionInfo.stoppedReason).toBe("StoppedByEV");
      expect(ended.transactionInfo.transactionId).toBe(
        started.transactionInfo.transactionId,
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("derives stoppedReason from the 1.6 reason when none is named (unchanged default)", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-WIDTH-DEFAULT-STOP");
    try {
      await cp.startTransaction("TAG-335", 1);
      await csms.waitForFrame(transactionEvent("Started"));
      cp.stopTransaction(1, "HardReset");
      const ended = payload(await csms.waitForFrame(transactionEvent("Ended")));
      expect(ended.triggerReason).toBe("StopAuthorized");
      expect(ended.transactionInfo.stoppedReason).toBe("ImmediateReset");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("sends a driven Updated event with the caller's triggerReason, chargingState and metered sampledValues carrying context", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-WIDTH-UPDATED");
    try {
      await cp.startTransaction("TAG-335", 1);
      const started = payload(
        await csms.waitForFrame(transactionEvent("Started")),
      );
      cp.setMeterValue(1, 1500);

      // No transaction on connector 2 → nothing is sent, no throw.
      const before = csms.received.length - 1;
      cp.sendTransactionUpdate(1, {
        triggerReason: "MeterValuePeriodic",
        meterValues: true,
        context: "Sample.Clock",
      });
      const periodic = payload(
        await csms.waitForFrame(transactionEvent("Updated", before, csms)),
      );
      expect(periodic.triggerReason).toBe("MeterValuePeriodic");
      expect(periodic.transactionInfo.transactionId).toBe(
        started.transactionInfo.transactionId,
      );
      expect(periodic.transactionInfo.chargingState).toBeUndefined();
      expect(periodic.seqNo).toBe(started.seqNo + 1);
      const sampled = periodic.meterValue?.[0]?.sampledValue ?? [];
      expect(sampled.length).toBeGreaterThan(0);
      for (const sv of sampled) {
        expect(sv.context).toBe("Sample.Clock");
        expect(typeof sv.value).toBe("number");
      }
      // The builder reports the register in Wh (the Started/Ended events
      // convert to kWh themselves); the driven event carries the builder's
      // value and unit as they are.
      const register = sampled.find(
        (sv) => sv.measurand === "Energy.Active.Import.Register",
      );
      expect(register?.value).toBe(1500);
      expect(register?.unitOfMeasure?.unit).toBe("Wh");

      // A named chargingState is carried, and becomes the de-dup baseline:
      // the following StatusNotification to the same state stays silent.
      const beforeState = csms.received.length - 1;
      cp.sendTransactionUpdate(1, {
        triggerReason: "EVDetected",
        chargingState: "SuspendedEV",
      });
      const detected = payload(
        await csms.waitForFrame(transactionEvent("Updated", beforeState, csms)),
      );
      expect(detected.triggerReason).toBe("EVDetected");
      expect(detected.transactionInfo.chargingState).toBe("SuspendedEV");
      expect(detected.meterValue).toBeUndefined();
      expect(detected.seqNo).toBe(periodic.seqNo + 1);

      const beforeDuplicate = csms.received.length - 1;
      cp.updateConnectorStatus(1, OCPPStatus.SuspendedEV);
      let duplicate: OcppFrame | null = null;
      try {
        duplicate = await csms.waitForFrame(
          transactionEvent("Updated", beforeDuplicate, csms),
          150,
        );
      } catch {
        duplicate = null;
      }
      expect(duplicate).toBeNull();

      cp.stopTransaction(1);
      const ended = payload(await csms.waitForFrame(transactionEvent("Ended")));
      expect(ended.seqNo).toBe(detected.seqNo + 1);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("ignores a driven Updated event when no transaction is running", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-WIDTH-NO-TX");
    try {
      const before = csms.received.length - 1;
      cp.sendTransactionUpdate(1, { triggerReason: "Trigger" });
      let frame: OcppFrame | null = null;
      try {
        frame = await csms.waitForFrame(
          transactionEvent("Updated", before, csms),
          150,
        );
      } catch {
        frame = null;
      }
      expect(frame).toBeNull();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("puts the requested ReadingContext on standalone MeterValues sampledValues", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-WIDTH-CONTEXT");
    try {
      cp.setMeterValue(1, 250);
      cp.sendMeterValue(1, "Trigger");
      const frame = await csms.waitForFrame(
        (f) => f[0] === 2 && f[2] === "MeterValues",
      );
      const mv = frame[3] as MeterValuesRequestV201;
      const sampled = mv.meterValue[0].sampledValue;
      expect(sampled.length).toBeGreaterThan(0);
      for (const sv of sampled) expect(sv.context).toBe("Trigger");

      cp.sendMeterValue(1);
      const second = await csms.waitForFrame(
        (f) =>
          f[0] === 2 &&
          f[2] === "MeterValues" &&
          csms.received.indexOf(f) > csms.received.indexOf(frame),
      );
      for (const sv of (second[3] as MeterValuesRequestV201).meterValue[0]
        .sampledValue)
        expect(sv.context).toBe("Sample.Periodic");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("on OCPP 1.6 a driven Updated event sends nothing", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-WIDTH", "OCPP-1.6");
    try {
      // 1.6's CALL queue is strictly serial: every StatusNotification needs
      // its CALLRESULT before the next frame goes out (#176 wire order).
      const replyStatus = async (connectorId: number, status: string) => {
        const frame = await csms.waitForFrame(
          (f) =>
            f[0] === 2 &&
            f[2] === "StatusNotification" &&
            (f[3] as { connectorId?: number }).connectorId === connectorId &&
            (f[3] as { status?: string }).status === status,
        );
        csms.replyCallResult(frame[1] as string, {});
      };
      await replyStatus(0, "Available");
      await replyStatus(1, "Available");
      cp.startTransaction("TAG-335", 1);
      await replyStatus(1, "Preparing");
      const start = await csms.waitForCall("StartTransaction");
      csms.replyCallResult(start.messageId, {
        transactionId: 7,
        idTagInfo: { status: "Accepted" },
      });
      await replyStatus(1, "Charging");
      const before = csms.received.length;
      cp.sendTransactionUpdate(1, {
        triggerReason: "MeterValuePeriodic",
        meterValues: true,
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(
        csms.received
          .slice(before)
          .filter((f) => f[0] === 2)
          .map((f) => f[2]),
      ).toEqual([]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
