import { describe, expect, it } from "bun:test";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import type { OperationalTimeline } from "../../../application/services/OperationalTimeline";
import { resolveNetworkSimConfig } from "../network-sim";
import { startMockCsms, type MockCsms } from "./mockCsms";
import { canBindBunServe } from "../../../../test/bunServe";

/**
 * #448 acceptance: an injected network fault, the disconnect it causes, the
 * reconnect, the new BootNotification and the status recovery are recorded
 * in order on the operational timeline and correlated by one incident id.
 * Real socket, real network-sim rule, real reconnect.
 */

/** Answers every CALL the charge point sends, once. */
function autoAnswer(csms: MockCsms): () => void {
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const frame of csms.received) {
      const [type, messageId, action] = frame as [number, string, string];
      if (type !== 2 || answered.has(messageId)) continue;
      answered.add(messageId);
      csms.replyCallResult(
        messageId,
        action === "BootNotification"
          ? {
              status: "Accepted",
              currentTime: new Date().toISOString(),
              interval: 300,
            }
          : action === "Heartbeat"
            ? { currentTime: new Date().toISOString() }
            : {},
      );
    }
  }, 10);
  return () => clearInterval(timer);
}

async function until(
  timeline: OperationalTimeline,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out; timeline: ${timeline
          .query()
          .entries.map((e) => e.kind)
          .join(", ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!canBindBunServe())(
  "Operational timeline: fault → recovery (#448)",
  () => {
    it("correlates an injected disconnect with the reconnect and status recovery", async () => {
      const csms = startMockCsms();
      const stopAnswering = autoAnswer(csms);
      const cp = new ChargePoint(
        "CP-TIMELINE",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      cp.events.on("error", () => undefined);
      const timeline = cp.timeline;
      const connectorAvailable = () =>
        cp.getConnector(1)?.status === "Available";

      try {
        cp.connect();
        await until(timeline, connectorAvailable);

        cp.setNetworkSimConfig(
          resolveNetworkSimConfig(
            {
              enabled: true,
              seed: 1,
              rules: {
                cut: { type: "manual-disconnect", reconnectDelayMs: 300 },
              },
            },
            null,
            "CP-TIMELINE",
          ),
        );
        const before = timeline.query().total;

        expect(cp.triggerNetworkSimDisconnect("cut")).toEqual({ ok: true });
        await until(
          timeline,
          () => timeline.query({ kinds: ["recovery_completed"] }).total > 0,
        );

        const entries = timeline.query().entries.slice(before);
        expect(entries.map((e) => [e.kind, e.connectorId])).toEqual([
          ["network_fault_injected", undefined],
          ["connector_status", 1],
          ["status_change", undefined],
          ["disconnected", undefined],
          ["reconnecting", undefined],
          ["connected", undefined],
          ["boot_notification", undefined],
          ["status_change", undefined],
          ["connector_status", 1],
          ["recovery_completed", undefined],
        ]);

        const [fault] = entries;
        expect(fault!.incidentId).toEqual(expect.any(String));
        expect(new Set(entries.map((e) => e.incidentId))).toEqual(
          new Set([fault!.incidentId]),
        );
        const seqs = entries.map((e) => e.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

        const recovery = entries.at(-1)!;
        expect(recovery.data.ruleId).toBe("cut");
        expect(recovery.data.durationMs).toBeGreaterThanOrEqual(300);
        expect(recovery.data.durationMs).toBe(
          Date.parse(recovery.timestamp) - Date.parse(fault!.timestamp),
        );
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
