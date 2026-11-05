import { describe, it, expect } from "bun:test";
import { startMockCsms } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
} from "./stationHarness";

/**
 * #348: `ChargePoint.sendDataTransfer` resolves with the CSMS's answer.
 *
 * Before, the CALL went out and the CALLRESULT was logged; nothing on the
 * control plane could produce a station-initiated DataTransfer.req at all,
 * and nothing could read the answer. Now the promise is the answer, on both
 * JSON versions, and a CALLERROR is a rejection rather than a log line.
 */
const dataTransferCall = callOf("DataTransfer");

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
    const cp = await bootedChargePoint(csms, "CP16-DT", "OCPP-1.6J");
    const stop = answerEverythingElse(csms, ["DataTransfer"]);
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
    const cp = await bootedChargePoint(csms, "CP16-DT-OBJ", "OCPP-1.6J");
    const stop = answerEverythingElse(csms, ["DataTransfer"]);
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
