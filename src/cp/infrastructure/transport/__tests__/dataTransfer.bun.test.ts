import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * #348: `ChargePoint.sendDataTransfer` resolves with the CSMS's answer.
 *
 * Before, the CALL went out and the CALLRESULT was logged; nothing on the
 * control plane could produce a station-initiated DataTransfer.req at all,
 * and nothing could read the answer. Now the promise is the answer, on both
 * JSON versions, and a CALLERROR is a rejection rather than a log line.
 */
async function bootedChargePoint(
  csms: MockCsms,
  id: string,
  version: "OCPP-2.0.1" | "OCPP-1.6",
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
  cp.connect();
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-09-17T00:00:00.000Z",
    interval: 300,
  });
  // The boot gate opens when the CALLRESULT above has been processed; the
  // StatusNotification the charge point sends next is the sign that it has.
  await csms.waitForFrame(
    (frame) => frame[0] === 2 && frame[2] === "StatusNotification",
  );
  return cp;
}

/**
 * 1.6's CALL queue is strictly serial (#176): every StatusNotification ahead
 * of the DataTransfer needs its CALLRESULT before the next frame goes out.
 * Answer everything that is not a DataTransfer with an empty result.
 */
function answerEverythingElse(csms: MockCsms): () => void {
  const answered = new Set<string>();
  const tick = setInterval(() => {
    for (const frame of csms.received) {
      if (frame[0] !== 2) continue;
      const id = frame[1] as string;
      if (answered.has(id) || frame[2] === "DataTransfer") continue;
      answered.add(id);
      if (frame[2] === "BootNotification") continue; // bootedChargePoint's
      csms.replyCallResult(id, {});
    }
  }, 5);
  return () => clearInterval(tick);
}

function dataTransferCall(frame: OcppFrame): boolean {
  return frame[0] === 2 && frame[2] === "DataTransfer";
}

describe("sendDataTransfer resolves with the CSMS's answer (#348)", () => {
  it("2.0.1: an object rides the wire as JSON and the answer's status/data come back", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-DT", "OCPP-2.0.1");
    try {
      const answer = cp.sendDataTransfer("VendorX", "ping", { n: 1 });
      const call = await csms.waitForFrame(dataTransferCall);
      expect(call[3]).toEqual({
        vendorId: "VendorX",
        messageId: "ping",
        data: { n: 1 },
      });
      csms.replyCallResult(call[1] as string, {
        status: "Accepted",
        data: { echo: 1 },
      });
      expect(await answer).toEqual({ status: "Accepted", data: { echo: 1 } });
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("2.0.1: a CALLERROR rejects the promise with the error code", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-DT-ERR", "OCPP-2.0.1");
    try {
      const answer = cp.sendDataTransfer("VendorX");
      const call = await csms.waitForFrame(dataTransferCall);
      csms.send([4, call[1], "NotImplemented", "vendor unknown here", {}]);
      await expect(answer).rejects.toThrow(/CALLERROR NotImplemented/);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("1.6: a string rides as-is and the answer comes back without data", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-DT", "OCPP-1.6");
    const stop = answerEverythingElse(csms);
    try {
      const answer = cp.sendDataTransfer("VendorX", "m1", "hello");
      const call = await csms.waitForFrame(dataTransferCall);
      expect(call[3]).toEqual({
        vendorId: "VendorX",
        messageId: "m1",
        data: "hello",
      });
      csms.replyCallResult(call[1] as string, { status: "UnknownVendorId" });
      expect(await answer).toEqual({ status: "UnknownVendorId" });
    } finally {
      stop();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("1.6: an object is JSON-encoded because 1.6's `data` is a string", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-DT-OBJ", "OCPP-1.6");
    const stop = answerEverythingElse(csms);
    try {
      const answer = cp.sendDataTransfer("VendorX", undefined, { n: 1 });
      const call = await csms.waitForFrame(dataTransferCall);
      expect(call[3]).toEqual({ vendorId: "VendorX", data: '{"n":1}' });
      csms.replyCallResult(call[1] as string, {
        status: "Accepted",
        data: "ok",
      });
      expect(await answer).toEqual({ status: "Accepted", data: "ok" });
    } finally {
      stop();
      cp.disconnect();
      await csms.stop();
    }
  });
});
