import { describe, it, expect } from "bun:test";
import {
  startMockCsms,
  type MockCsms,
} from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import { CLIChargePointService } from "../../service";
import { runStartupScenario } from "../startServer";

/**
 * OCPP CALLs are serialized one-in-flight-at-a-time (§4.1.1) — the next
 * queued CALL only goes out once the previous one's CALLRESULT arrives.
 * Boot acceptance alone fans out several StatusNotification.req (CP +
 * every connector) ahead of the scenario's own Start Transaction node, so
 * without an auto-responder for those, StartTransaction.req would sit
 * queued forever behind an un-acked StatusNotification and this test
 * would hang. Real CSMS's do this as a matter of course; this just keeps
 * the mock CSMS from stalling the pipeline while we control the timing
 * of the two calls we actually care about (BootNotification,
 * StartTransaction).
 */
function autoAckStatusNotifications(csms: MockCsms): () => void {
  const acked = new Set<string>();
  const timer = setInterval(() => {
    for (const frame of csms.received) {
      if (frame[0] !== 2) continue;
      const messageId = frame[1] as string;
      if (frame[2] === "StatusNotification" && !acked.has(messageId)) {
        acked.add(messageId);
        csms.replyCallResult(messageId, {});
      }
    }
  }, 5);
  return () => clearInterval(timer);
}

/**
 * Issue #174 (verified live against a real CSMS): the CLI startup-scenario
 * path used to call `runScenario()` immediately after `connect()` resolved
 * — but `connect()` only waits for the WebSocket "connected" event, not
 * for BootNotification.conf. The `cert16-tc005-ev-side-disconnect`
 * template (the exact repro scenario from the bug report) has no leading
 * delay before its Start Transaction node, so it could send
 * StartTransaction.req while the boot gate was still closed.
 * `OCPPMessageHandler.sendRequest`'s boot-gate check silently drops any
 * gated outgoing CALL sent before Accepted (see `isCallAllowed`), so the
 * scenario proceeded with a locally fabricated `transactionId` (0, see
 * `ChargePoint.startTransaction`) that the CSMS never actually saw.
 *
 * This test calls the REAL, exported `runStartupScenario` (not a
 * hand-rolled mirror) against a REAL mock CSMS (a real `Bun.serve`
 * WebSocket server) and confirms:
 *   (a) StartTransaction is NOT sent while boot is still pending,
 *   (b) it IS sent — and gets a real CSMS-assigned transactionId, not
 *       the fabricated 0 — promptly once boot is accepted, and
 *   (c) no spurious "already running" / "failed to start" error is
 *       logged (an earlier version of this fix raced its own explicit
 *       runScenario() call against CLIChargePointService's pre-existing
 *       loadScenario-time auto-start for manual/"connect"-trigger
 *       scenarios).
 */
describe("CLI startup-scenario boot-gate guard (issue #174)", () => {
  it("does not send StartTransaction before BootNotification is accepted, and fires promptly once it is", async () => {
    const csms = startMockCsms();
    const svc = new CLIChargePointService({
      cpId: "cp174",
      wsUrl: csms.url,
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
    });

    const stderrLines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrLines.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    const stopAutoAck = autoAckStatusNotifications(csms);

    try {
      await svc.connect();

      const boot = await csms.waitForCall("BootNotification");

      // Fire the real startup-scenario entry point. It must not resolve
      // (or send anything) until boot is accepted below.
      const runPromise = runStartupScenario(
        svc,
        {
          scenario: null,
          scenarioTemplate: "cert16-tc005-ev-side-disconnect",
          scenarioTemplateFile: null,
          scenarioConnector: "1",
        },
        1,
      );

      // No leading delay in this template — an unguarded caller would
      // already have sent StartTransaction well within this window.
      await new Promise((r) => setTimeout(r, 150));
      expect(csms.received.some((f) => f[2] === "StartTransaction")).toBe(
        false,
      );

      csms.replyCallResult(boot.messageId, {
        currentTime: new Date().toISOString(),
        interval: 300,
        status: "Accepted",
      });

      const startTx = await csms.waitForCall("StartTransaction", 5_000);
      await runPromise;

      // Real transactionId assigned by the CSMS — not the fabricated
      // local placeholder (0) the bug left behind when the CALL was
      // silently dropped by the boot gate.
      csms.replyCallResult(startTx.messageId, {
        transactionId: 5150,
        idTagInfo: { status: "Accepted" },
      });
      await new Promise((r) => setTimeout(r, 50));
      const status = svc.getStatus();
      expect(status.connectors[0]?.transactionId).toBe(5150);

      const spurious = stderrLines.filter(
        (line) =>
          line.includes("already running") ||
          line.includes("Failed to start scenario"),
      );
      expect(spurious).toEqual([]);
    } finally {
      process.stderr.write = realWrite;
      stopAutoAck();
      svc.disconnect();
      await csms.stop();
    }
  });
});
