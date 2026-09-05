import type { CPRegistry } from "../CPRegistry";
import {
  CALL_DURATION_BUCKETS_SECONDS,
  type MetricsRecorder,
} from "./MetricsRecorder";

/**
 * Escape a Prometheus label value: backslash, double quote and newline, in
 * that order (escaping the backslash last would double-escape the others).
 */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function labels(pairs: Record<string, string>): string {
  const rendered = Object.entries(pairs)
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(",");
  return rendered ? `{${rendered}}` : "";
}

class Exposition {
  private readonly lines: string[] = [];

  metric(name: string, help: string, type: "counter" | "gauge"): void {
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  }

  histogram(name: string, help: string): void {
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
  }

  sample(name: string, pairs: Record<string, string>, value: number): void {
    this.lines.push(`${name}${labels(pairs)} ${value}`);
  }

  toString(): string {
    // Prometheus text format requires the body to end with a newline.
    return this.lines.join("\n") + "\n";
  }
}

/**
 * Render the Prometheus text exposition for one scrape.
 *
 * Gauges are read from the registry here rather than tracked incrementally:
 * a charge point's state changes through many paths (RPC, scenario, CSMS
 * command, reconnect), and a counter that had to be decremented on every one
 * of them would drift. Counting the live registry at scrape time cannot.
 */
export function renderMetrics(
  registry: CPRegistry,
  recorder: MetricsRecorder,
): string {
  const out = new Exposition();

  const cpStates = new Map<string, number>();
  const connectorStates = new Map<string, number>();
  let transactions = 0;

  for (const cpId of registry.list()) {
    const status = registry.get(cpId)?.getStatus();
    if (!status) continue;
    bump(cpStates, String(status.status));
    for (const connector of status.connectors) {
      bump(connectorStates, String(connector.status));
      // `transactionStartTime` rather than `transactionId`: the numeric id is
      // 0 until the CSMS answers StartTransaction on 1.6, and on 2.x it is
      // never set at all (the real identifier is the transaction's own
      // `cpTransactionId`). The start time is set for both.
      if (connector.transactionStartTime != null) transactions++;
    }
  }

  out.metric(
    "ocppcp_charge_points",
    "Registered charge points by current status.",
    "gauge",
  );
  for (const [state, count] of sorted(cpStates)) {
    out.sample("ocppcp_charge_points", { state }, count);
  }

  out.metric(
    "ocppcp_connectors",
    "Connectors across all charge points by current status.",
    "gauge",
  );
  for (const [status, count] of sorted(connectorStates)) {
    out.sample("ocppcp_connectors", { status }, count);
  }

  out.metric(
    "ocppcp_transactions_active",
    "Connectors currently in a transaction.",
    "gauge",
  );
  out.sample("ocppcp_transactions_active", {}, transactions);

  out.metric(
    "ocppcp_ocpp_messages_total",
    "OCPP messages observed, by action and direction.",
    "counter",
  );
  for (const [key, count] of sorted(recorder.messages)) {
    const [action, direction] = splitLast(key);
    out.sample("ocppcp_ocpp_messages_total", { action, direction }, count);
  }

  out.metric(
    "ocppcp_ocpp_call_errors_total",
    "CALLERROR frames observed, by action.",
    "counter",
  );
  for (const [action, count] of sorted(recorder.callErrors)) {
    out.sample("ocppcp_ocpp_call_errors_total", { action }, count);
  }

  // Deliberately separate from the duration histogram: a CALL that is never
  // answered produces no duration observation at all, so a saturated CSMS
  // would otherwise show up as "no slow calls, no errors". This counter is
  // the only signal that says a call was given up on.
  out.metric(
    "ocppcp_ocpp_call_timeouts_total",
    "CALLs the transport gave up on without an answer, by action.",
    "counter",
  );
  for (const [action, count] of sorted(recorder.callTimeouts)) {
    out.sample("ocppcp_ocpp_call_timeouts_total", { action }, count);
  }

  // Not a failure signal and emphatically not a timeout: the transport still
  // holds the evicted CALL and the CSMS may answer it. What is lost is the
  // duration sample, so a non-zero value here means the latency histogram
  // below is missing that many observations — which is why it is exposed at
  // all rather than dropped silently.
  out.metric(
    "ocppcp_ocpp_pending_calls_evicted_total",
    "In-flight CALLs dropped from the latency correlation cache because it was full (a recorder capacity event, not a timeout); each one costs one duration sample.",
    "counter",
  );
  out.sample(
    "ocppcp_ocpp_pending_calls_evicted_total",
    {},
    recorder.pendingEvictions,
  );

  out.metric(
    "ocppcp_rpc_requests_total",
    "Control-plane rpc calls, by method and outcome.",
    "counter",
  );
  for (const [key, count] of sorted(recorder.rpcRequests)) {
    const [method, outcome] = splitLast(key);
    out.sample("ocppcp_rpc_requests_total", { method, outcome }, count);
  }

  out.metric(
    "ocppcp_ws_reconnects_total",
    "WebSocket reconnect attempts across all charge points.",
    "counter",
  );
  out.sample("ocppcp_ws_reconnects_total", {}, recorder.reconnects);

  out.histogram(
    "ocppcp_ocpp_call_duration_seconds",
    "Round-trip time from a CALL to its CALLRESULT or CALLERROR, by action.",
  );
  for (const [action, series] of sorted(recorder.callDurations)) {
    for (let i = 0; i < CALL_DURATION_BUCKETS_SECONDS.length; i++) {
      out.sample(
        "ocppcp_ocpp_call_duration_seconds_bucket",
        { action, le: String(CALL_DURATION_BUCKETS_SECONDS[i]) },
        series.buckets[i] ?? 0,
      );
    }
    // +Inf is mandatory and equals the total count.
    out.sample(
      "ocppcp_ocpp_call_duration_seconds_bucket",
      { action, le: "+Inf" },
      series.count,
    );
    out.sample("ocppcp_ocpp_call_duration_seconds_sum", { action }, series.sum);
    out.sample(
      "ocppcp_ocpp_call_duration_seconds_count",
      { action },
      series.count,
    );
  }

  return out.toString();
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Stable output so a diff between two scrapes is readable. */
function sorted<T>(map: Map<string, T>): Array<[string, T]> {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Split a `"<value> <suffix>"` composite key. Split on the LAST space: an
 * action never contains one, but a method or an action recovered from a
 * malformed frame might, and the suffix (direction / outcome) is a fixed word.
 */
function splitLast(key: string): [string, string] {
  const at = key.lastIndexOf(" ");
  if (at < 0) return [key, ""];
  return [key.slice(0, at), key.slice(at + 1)];
}
