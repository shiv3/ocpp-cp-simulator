import { describe, expect, it } from "vitest";

import { CPRegistry } from "../CPRegistry";
import { Logger, LogType } from "../../../cp/shared/Logger";
import {
  CALL_DURATION_BUCKETS_SECONDS,
  MetricsRecorder,
  RECONNECT_ATTEMPT_PREFIX,
} from "../metrics/MetricsRecorder";
import { renderMetrics } from "../metrics/render";
import type { OcppTraceRecord } from "../../../trace/OcppTraceRecord";

function call(
  action: string,
  messageId: string,
  timestamp: string,
): OcppTraceRecord {
  return {
    schemaVersion: "1.1",
    timestamp,
    transport: "json",
    direction: "cp-to-csms",
    messageType: "CALL",
    messageId,
    action,
  };
}

function result(messageId: string, timestamp: string): OcppTraceRecord {
  return {
    schemaVersion: "1.1",
    timestamp,
    transport: "json",
    direction: "csms-to-cp",
    messageType: "CALLRESULT",
    messageId,
  };
}

/** Parse `name{labels} value` samples out of an exposition. */
function samples(text: string, name: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue;
    const at = line.lastIndexOf(" ");
    found.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return found;
}

describe("MetricsRecorder (#298)", () => {
  it("counts messages by action and direction", () => {
    const recorder = new MetricsRecorder();
    recorder.observe(call("BootNotification", "1", "2026-01-01T00:00:00.000Z"));
    recorder.observe(call("Heartbeat", "2", "2026-01-01T00:00:01.000Z"));
    recorder.observe(call("Heartbeat", "3", "2026-01-01T00:00:02.000Z"));

    expect(recorder.messages.get("BootNotification cp-to-csms")).toBe(1);
    expect(recorder.messages.get("Heartbeat cp-to-csms")).toBe(2);
  });

  it("times a call from its CALL to the answer", () => {
    const recorder = new MetricsRecorder();
    recorder.observe(call("BootNotification", "1", "2026-01-01T00:00:00.000Z"));
    recorder.observe(result("1", "2026-01-01T00:00:00.250Z"));

    const series = recorder.callDurations.get("BootNotification");
    expect(series?.count).toBe(1);
    expect(series?.sum).toBeCloseTo(0.25);
    // Cumulative: every bucket at or above 0.25s holds the observation.
    const at250ms = CALL_DURATION_BUCKETS_SECONDS.indexOf(0.25);
    expect(series?.buckets[at250ms]).toBe(1);
    expect(series?.buckets[at250ms - 1]).toBe(0);
  });

  it("attributes the duration to the action, which only the CALL carried", () => {
    // A CALLRESULT frame has no action of its own; correlation by messageId is
    // the only thing that can name the series.
    const recorder = new MetricsRecorder();
    recorder.observe(call("Authorize", "abc", "2026-01-01T00:00:00.000Z"));
    recorder.observe(result("abc", "2026-01-01T00:00:00.100Z"));
    expect([...recorder.callDurations.keys()]).toEqual(["Authorize"]);
  });

  it("counts CALLERRORs separately from the round trip", () => {
    const recorder = new MetricsRecorder();
    recorder.observe(call("DataTransfer", "1", "2026-01-01T00:00:00.000Z"));
    recorder.observe({
      schemaVersion: "1.1",
      timestamp: "2026-01-01T00:00:00.050Z",
      transport: "json",
      direction: "csms-to-cp",
      messageType: "CALLERROR",
      messageId: "1",
      action: "DataTransfer",
    });

    expect(recorder.callErrors.get("DataTransfer")).toBe(1);
    // An error is still an answer, so it still times the call.
    expect(recorder.callDurations.get("DataTransfer")?.count).toBe(1);
  });

  it("ignores an answer to a CALL it never saw", () => {
    const recorder = new MetricsRecorder();
    recorder.observe(result("never-seen", "2026-01-01T00:00:00.000Z"));
    expect(recorder.callDurations.size).toBe(0);
  });

  it("does not grow without bound when answers never arrive", () => {
    // A CSMS that stops answering would otherwise leak one entry per CALL for
    // the life of the daemon.
    const recorder = new MetricsRecorder();
    for (let i = 0; i < 10_000; i++) {
      recorder.observe(
        call("Heartbeat", `id-${i}`, "2026-01-01T00:00:00.000Z"),
      );
    }
    // The oldest entries are dropped, so the newest still correlates.
    recorder.observe(result("id-9999", "2026-01-01T00:00:00.100Z"));
    expect(recorder.callDurations.get("Heartbeat")?.count).toBe(1);
  });

  it("counts rpc calls by method and outcome", () => {
    const recorder = new MetricsRecorder();
    recorder.countRpc("cp.create", "ok");
    recorder.countRpc("cp.create", "error");
    recorder.countRpc("cp.create", "ok");
    expect(recorder.rpcRequests.get("cp.create ok")).toBe(2);
    expect(recorder.rpcRequests.get("cp.create error")).toBe(1);
  });
});

describe("renderMetrics (#298)", () => {
  it("renders a parseable exposition ending in a newline", () => {
    const registry = new CPRegistry();
    try {
      const text = renderMetrics(registry, new MetricsRecorder());
      expect(text.endsWith("\n")).toBe(true);
      for (const line of text.split("\n").filter(Boolean)) {
        // Either a comment or `name{labels} value`.
        expect(line).toMatch(/^(#\s|[a-zA-Z_][a-zA-Z0-9_]*(\{.*\})? -?[\d.]+)/);
      }
    } finally {
      registry.shutdownAll();
    }
  });

  it("declares HELP and TYPE for every metric it emits", () => {
    const registry = new CPRegistry();
    try {
      const recorder = new MetricsRecorder();
      recorder.observe(call("Heartbeat", "1", "2026-01-01T00:00:00.000Z"));
      recorder.observe(result("1", "2026-01-01T00:00:00.010Z"));
      recorder.countRpc("cp.list", "ok");
      const text = renderMetrics(registry, recorder);

      const declared = new Set(
        text
          .split("\n")
          .filter((l) => l.startsWith("# TYPE "))
          .map((l) => l.split(" ")[2]!),
      );
      const emitted = new Set(
        text
          .split("\n")
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.split(/[{ ]/)[0]!)
          // Histogram sample names are suffixed forms of the declared name.
          .map((n) => n.replace(/_(bucket|sum|count)$/, "")),
      );
      for (const name of emitted) expect(declared).toContain(name);
    } finally {
      registry.shutdownAll();
    }
  });

  it("carries no cpId label anywhere", () => {
    // Unbounded by construction once a daemon holds a fleet: Prometheus pays
    // for every series it has ever seen, so this is a hard rule, not taste.
    const registry = new CPRegistry();
    try {
      const recorder = new MetricsRecorder();
      recorder.observe(call("Heartbeat", "1", "2026-01-01T00:00:00.000Z"));
      recorder.countRpc("cp.list", "ok");
      expect(renderMetrics(registry, recorder)).not.toContain("cpId");
    } finally {
      registry.shutdownAll();
    }
  });

  it("emits the mandatory +Inf bucket equal to the count", () => {
    const registry = new CPRegistry();
    try {
      const recorder = new MetricsRecorder();
      recorder.observe(call("Heartbeat", "1", "2026-01-01T00:00:00.000Z"));
      recorder.observe(result("1", "2026-01-01T00:01:00.000Z"));
      const text = renderMetrics(registry, recorder);
      const found = samples(text, "ocppcp_ocpp_call_duration_seconds");

      expect(
        found.get(
          'ocppcp_ocpp_call_duration_seconds_bucket{action="Heartbeat",le="+Inf"}',
        ),
      ).toBe(1);
      expect(
        found.get(
          'ocppcp_ocpp_call_duration_seconds_count{action="Heartbeat"}',
        ),
      ).toBe(1);
      // 60s is past the last finite bucket, so only +Inf holds it.
      expect(
        found.get(
          'ocppcp_ocpp_call_duration_seconds_bucket{action="Heartbeat",le="30"}',
        ),
      ).toBe(0);
    } finally {
      registry.shutdownAll();
    }
  });

  it("counts an empty daemon as zero rather than omitting the metric", () => {
    const registry = new CPRegistry();
    try {
      const text = renderMetrics(registry, new MetricsRecorder());
      expect(text).toContain("ocppcp_transactions_active 0");
      expect(text).toContain("ocppcp_ws_reconnects_total 0");
    } finally {
      registry.shutdownAll();
    }
  });
});

describe("reconnect counting is coupled to the transport's log line (#298)", () => {
  it("matches the prefix OCPPWebSocket actually emits", () => {
    // The daemon counts reconnects off the log stream so the transport — which
    // also runs in the browser — need not import a Prometheus recorder. That
    // makes the wording load-bearing, so pin it here: if OCPPWebSocket's line
    // changes, this fails instead of the metric silently going flat.
    const emitted = `Attempting reconnection (attempt 3)...`;
    expect(emitted.startsWith(RECONNECT_ATTEMPT_PREFIX)).toBe(true);
  });
});

describe("attach() reads the real log stream (#298)", () => {
  it("counts the wire lines OCPPWebSocket writes, in both directions", () => {
    // The seam is a log subscription, so the thing worth proving is that the
    // lines the transport actually emits — `Sent: ` / `Received: ` with an
    // OCPP-J frame — reach the counters. A recorder that attached but matched
    // nothing would look healthy and report zero forever.
    const recorder = new MetricsRecorder();
    const logger = new Logger();
    const unsubscribe = recorder.attach({
      cpId: "CP001",
      ocppVersion: "OCPP-1.6J",
      logger,
    });
    try {
      logger.info(
        'Sent: [2,"m1","BootNotification",{"chargePointVendor":"V"}]',
        LogType.OCPP,
      );
      logger.info('Received: [3,"m1",{"status":"Accepted"}]', LogType.OCPP);
      logger.info("Attempting reconnection (attempt 1)...", LogType.WEBSOCKET);

      expect(recorder.messages.get("BootNotification cp-to-csms")).toBe(1);
      expect(recorder.callDurations.get("BootNotification")?.count).toBe(1);
      expect(recorder.reconnects).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("stops counting once detached", () => {
    const recorder = new MetricsRecorder();
    const logger = new Logger();
    recorder.attach({ cpId: "CP001", logger })();
    logger.info('Sent: [2,"m1","Heartbeat",{}]', LogType.OCPP);
    expect(recorder.messages.size).toBe(0);
  });

  it("survives a log line that is not a wire frame", () => {
    const recorder = new MetricsRecorder();
    const logger = new Logger();
    const unsubscribe = recorder.attach({ cpId: "CP001", logger });
    try {
      logger.info("Connector 1 status: Available", LogType.GENERAL);
      logger.info("Sent: not json at all", LogType.OCPP);
      expect(recorder.messages.size).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("multi-charge-point correlation (#298)", () => {
  it("does not let two charge points collide on a message id", () => {
    // OCPP message ids are only unique within a connection. Unscoped, CP-B's
    // CALL would overwrite CP-A's, CP-A's answer would be timed against the
    // wrong action, and CP-B's answer would find nothing left.
    const recorder = new MetricsRecorder();
    recorder.observe(
      { ...call("BootNotification", "1", "2026-01-01T00:00:00.000Z") },
      "CP-A",
    );
    recorder.observe(
      { ...call("Authorize", "1", "2026-01-01T00:00:00.000Z") },
      "CP-B",
    );
    recorder.observe(result("1", "2026-01-01T00:00:00.100Z"), "CP-A");
    recorder.observe(result("1", "2026-01-01T00:00:00.400Z"), "CP-B");

    expect(recorder.callDurations.get("BootNotification")?.count).toBe(1);
    expect(recorder.callDurations.get("BootNotification")?.sum).toBeCloseTo(
      0.1,
    );
    expect(recorder.callDurations.get("Authorize")?.count).toBe(1);
    expect(recorder.callDurations.get("Authorize")?.sum).toBeCloseTo(0.4);
  });

  it("falls back to the record's own chargePointId", () => {
    const recorder = new MetricsRecorder();
    const tagged = {
      ...call("Heartbeat", "1", "2026-01-01T00:00:00.000Z"),
      chargePointId: "CP-A",
    };
    recorder.observe(tagged);
    recorder.observe({
      ...result("1", "2026-01-01T00:00:00.050Z"),
      chargePointId: "CP-A",
    });
    expect(recorder.callDurations.get("Heartbeat")?.count).toBe(1);
  });
});

describe("SOAP charge points are counted too (#298)", () => {
  it("counts the operation names OCPPSoapHandler logs", () => {
    // logLineToTraceRecord only parses OCPP-J arrays, so a SOAP charge point
    // would otherwise appear in the gauges and be silent in every counter.
    const recorder = new MetricsRecorder();
    const logger = new Logger();
    const unsubscribe = recorder.attach({
      cpId: "CP-SOAP",
      ocppVersion: "OCPP-1.6S",
      logger,
    });
    try {
      logger.info(
        "SOAP POST BootNotification: <s:Envelope>…</s:Envelope>",
        LogType.OCPP,
      );
      logger.info(
        "SOAP response BootNotification: <soap:Envelope>…</soap:Envelope>",
        LogType.OCPP,
      );

      expect(recorder.messages.get("BootNotification cp-to-csms")).toBe(1);
      expect(recorder.messages.get("BootNotification csms-to-cp")).toBe(1);
      // No message id in a SOAP log line, so no duration to correlate.
      expect(recorder.callDurations.size).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("leaves OCPP-J charge points on the frame parser", () => {
    const recorder = new MetricsRecorder();
    const logger = new Logger();
    const unsubscribe = recorder.attach({
      cpId: "CP-J",
      ocppVersion: "OCPP-1.6J",
      logger,
    });
    try {
      logger.info("SOAP POST BootNotification: <x/>", LogType.OCPP);
      expect(recorder.messages.size).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});
