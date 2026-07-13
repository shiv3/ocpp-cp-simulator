import { describe, expect, it } from "vitest";
import { annotateOcppLogs } from "../logEntryParsing";

function msg(message: string) {
  return { message };
}

describe("annotateOcppLogs (#178 item E)", () => {
  describe("WebSocket transport frames", () => {
    it("parses an outgoing CALL as sent + action", () => {
      const logs = [
        msg(
          `Sent: ${JSON.stringify([2, "1", "BootNotification", { chargePointVendor: "Acme" }])}`,
        ),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "BootNotification", direction: "sent" },
      ]);
    });

    it("parses an incoming CALL as received + action", () => {
      const logs = [
        msg(
          `Received: ${JSON.stringify([2, "9", "RemoteStartTransaction", {}])}`,
        ),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "RemoteStartTransaction", direction: "received" },
      ]);
    });

    it("leaves a CALLRESULT with no prior CALL as direction-only", () => {
      const logs = [msg(`Sent: ${JSON.stringify([3, "unknown-id", {}])}`)];
      expect(annotateOcppLogs(logs)).toEqual([{ direction: "sent" }]);
    });

    it("correlates a CALLRESULT to the CP's own earlier CALL by message id", () => {
      // CP sends BootNotification (id "1"), CSMS replies with a CALLRESULT
      // carrying the same id. OCPP-J CALLRESULT frames never repeat the
      // action name, so the viewer must resolve it via correlation.
      const logs = [
        msg(
          `Sent: ${JSON.stringify([2, "1", "BootNotification", { chargePointVendor: "Acme" }])}`,
        ),
        msg(`Received: ${JSON.stringify([3, "1", { status: "Accepted" }])}`),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "BootNotification", direction: "sent" },
        { action: "BootNotification", direction: "received" },
      ]);
    });

    it("correlates a CALLERROR to the CP's own earlier CALL by message id", () => {
      const logs = [
        msg(`Sent: ${JSON.stringify([2, "5", "Heartbeat", {}])}`),
        msg(
          `Received: ${JSON.stringify([4, "5", "InternalError", "boom", {}])}`,
        ),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "Heartbeat", direction: "sent" },
        { action: "Heartbeat", direction: "received" },
      ]);
    });

    it("correlates the CP's own CALLRESULT back to a CSMS-initiated CALL it received", () => {
      // CSMS calls RemoteStartTransaction (id "77"), CP answers with a
      // CALLRESULT of its own (sent) carrying the same id.
      const logs = [
        msg(
          `Received: ${JSON.stringify([2, "77", "RemoteStartTransaction", {}])}`,
        ),
        msg(`Sent: ${JSON.stringify([3, "77", { status: "Accepted" }])}`),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "RemoteStartTransaction", direction: "received" },
        { action: "RemoteStartTransaction", direction: "sent" },
      ]);
    });

    it("does not cross-correlate distinct message ids", () => {
      const logs = [
        msg(`Sent: ${JSON.stringify([2, "1", "Heartbeat", {}])}`),
        msg(`Received: ${JSON.stringify([3, "2", {}])}`),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "Heartbeat", direction: "sent" },
        { direction: "received" },
      ]);
    });

    it("ignores a numeric message id array element but still stringifies for correlation", () => {
      const logs = [
        msg(`Sent: ${JSON.stringify([2, 42, "Heartbeat", {}])}`),
        msg(`Received: ${JSON.stringify([3, 42, {}])}`),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "Heartbeat", direction: "sent" },
        { action: "Heartbeat", direction: "received" },
      ]);
    });

    it("returns {} for malformed JSON after the Sent/Received prefix", () => {
      const logs = [msg("Sent: not-json"), msg("Received: {broken")];
      expect(annotateOcppLogs(logs)).toEqual([{}, {}]);
    });

    it("returns {} for a non-array JSON payload", () => {
      const logs = [msg(`Received: ${JSON.stringify({ foo: "bar" })}`)];
      expect(annotateOcppLogs(logs)).toEqual([{}]);
    });

    it("returns {} for the WebSocket error/diagnostic lines", () => {
      const logs = [
        msg("WebSocket connected successfully"),
        msg("Invalid message format: [1]"),
        msg("Error parsing message: SyntaxError"),
      ];
      expect(annotateOcppLogs(logs)).toEqual([{}, {}, {}]);
    });
  });

  describe("SOAP transport frames", () => {
    it("parses a SOAP POST as sent + operation", () => {
      const logs = [
        msg("SOAP POST BootNotification: <soap:Envelope>...</soap:Envelope>"),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "BootNotification", direction: "sent" },
      ]);
    });

    it("parses a SOAP response as received + operation", () => {
      const logs = [
        msg(
          "SOAP response BootNotification: <soap:Envelope>...</soap:Envelope>",
        ),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "BootNotification", direction: "received" },
      ]);
    });

    it("does not require correlation for SOAP (operation is always inline)", () => {
      const logs = [
        msg("SOAP POST Heartbeat: <soap:Envelope/>"),
        msg("SOAP response Heartbeat: <soap:Envelope/>"),
      ];
      expect(annotateOcppLogs(logs)).toEqual([
        { action: "Heartbeat", direction: "sent" },
        { action: "Heartbeat", direction: "received" },
      ]);
    });
  });

  describe("non-wire log lines", () => {
    it("returns {} for generic/diagnostic OCPP log lines", () => {
      const logs = [
        msg("Suppressing Heartbeat: blocked by the boot gate"),
        msg("Handling incoming message: 2, 1, BootNotification"),
        msg("Recovering connector 1 after StartTransaction CALLERROR"),
        msg("Scenario step completed: Connect to CSMS"),
      ];
      expect(annotateOcppLogs(logs)).toEqual([{}, {}, {}, {}]);
    });

    it("handles an empty log list", () => {
      expect(annotateOcppLogs([])).toEqual([]);
    });
  });
});
