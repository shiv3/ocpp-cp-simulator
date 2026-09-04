import {
  LogLevel,
  LogType,
  type LogEntry,
  type Logger,
} from "../../../cp/shared/Logger";
import { TraceCorrelator } from "../../../trace/TraceCorrelator";
import {
  logLineToTraceRecord,
  type SerializedLogLine,
} from "../../../trace/logEntryToTrace";
import type { OcppTraceRecord } from "../../../trace/OcppTraceRecord";
import { isSoapVersion } from "../../../cp/domain/types/OcppVersion";
import { toTraceOcppVersion } from "../../trace/TraceWriter";

export interface MetricsAttachContext {
  readonly cpId: string;
  readonly ocppVersion?: string;
  readonly logger: Logger;
}

/**
 * Histogram buckets for OCPP call round-trip, in seconds.
 *
 * Chosen around what matters for a CSMS under test rather than for even
 * spacing: anything under 100 ms is "fast", the 1-5 s band is where a
 * struggling CSMS shows up, and 30 s is the per-CALL watchdog, so the +Inf
 * bucket only ever holds calls that outlived their timeout.
 */
export const CALL_DURATION_BUCKETS_SECONDS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

/**
 * The line `OCPPWebSocket` writes when its backoff timer fires.
 *
 * Counting from the log stream keeps the daemon's metrics out of the transport
 * layer, which also runs in the browser and has no business importing a
 * Prometheus recorder. The coupling to the wording is real, so a test asserts
 * the exact line the transport emits still matches.
 */
export const RECONNECT_ATTEMPT_PREFIX = "Attempting reconnection";

/**
 * SOAP wire lines, which `logLineToTraceRecord` does not parse.
 *
 * That parser only recognises the OCPP-J `Sent: [...]` / `Received: [...]`
 * frames; passing `transport: "soap"` changes the label on a record, not what
 * gets recognised. So SOAP charge points would have been counted in the gauges
 * and silent in every counter. `OCPPSoapHandler` names the operation right in
 * the line, which is enough for the message counters.
 *
 * Durations are OCPP-J only: a SOAP exchange carries no message id in the log
 * line, so there is nothing to correlate a response back to its request with.
 */
const SOAP_REQUEST_PREFIX = "SOAP POST ";
const SOAP_RESPONSE_PREFIX = "SOAP response ";

/** `"SOAP POST BootNotification: <xml>"` to `"BootNotification"`. */
function soapOperation(message: string, prefix: string): string | null {
  const rest = message.slice(prefix.length);
  const colon = rest.indexOf(":");
  const operation = (colon < 0 ? rest : rest.slice(0, colon)).trim();
  return operation.length > 0 ? operation : null;
}

/**
 * How many in-flight CALLs are remembered for latency correlation.
 *
 * A CALL whose answer never arrives would otherwise leak one entry per message
 * for the life of the daemon. The map is trimmed oldest-first past this size:
 * losing a duration sample is the right trade against unbounded growth in a
 * process expected to run for days.
 */
const MAX_PENDING_CALLS = 4_096;

interface PendingCall {
  readonly action: string;
  readonly startedAtMs: number;
}

interface DurationSeries {
  buckets: number[];
  sum: number;
  count: number;
}

/**
 * Counts OCPP traffic for the `/metrics` endpoint.
 *
 * Fed from the same seam `--trace-output` uses: every charge point in every
 * mode is constructed through one `CLIChargePointService` constructor, and
 * `logLineToTraceRecord` turns its log lines into a typed record carrying the
 * action, direction and frame kind. One wiring point therefore covers OCPP-J
 * *and* SOAP and every version, where tapping the message handlers would have
 * meant one tap per handler and nothing at all for SOAP.
 *
 * Deliberately **not labelled by `cpId`**: that label is unbounded by
 * construction once a daemon holds a fleet, and a Prometheus server pays for
 * every series it has ever seen. Per-charge-point detail stays in `cp.list`
 * and the event stream.
 */
export class MetricsRecorder {
  private readonly correlator = new TraceCorrelator();
  private readonly pending = new Map<string, PendingCall>();

  /** `"<action> <direction>"` to count. */
  readonly messages = new Map<string, number>();
  /** action to CALLERROR count. */
  readonly callErrors = new Map<string, number>();
  /** action to histogram series. */
  readonly callDurations = new Map<string, DurationSeries>();
  /** `"<method> <outcome>"` to count. */
  readonly rpcRequests = new Map<string, number>();
  reconnects = 0;

  /** Subscribe to one charge point's log stream. Returns an unsubscribe. */
  attach(ctx: MetricsAttachContext): () => void {
    const transport = isSoapVersion(ctx.ocppVersion) ? "soap" : "json";
    const ocppVersion = toTraceOcppVersion(ctx.ocppVersion);

    const listener = (entry: LogEntry) => {
      // Logger.log() emits synchronously, so a fault here would propagate into
      // whatever OCPP code path logged the line and could take down every
      // charge point sharing the daemon. Metrics are never worth that.
      try {
        const line: SerializedLogLine = {
          timestamp: entry.timestamp.toISOString(),
          level: LogLevel[entry.level],
          type: entry.type,
          message: entry.message,
          cpId: ctx.cpId,
        };
        if (
          entry.type === LogType.WEBSOCKET &&
          entry.message.startsWith(RECONNECT_ATTEMPT_PREFIX)
        ) {
          this.countReconnect();
          return;
        }
        if (transport === "soap" && this.countSoapLine(entry.message)) return;
        const record = logLineToTraceRecord(line, {
          ocppVersion,
          transport,
          chargePointId: ctx.cpId,
        });
        if (!record) return;
        this.correlator.observe(record);
        this.observe(record, ctx.cpId);
      } catch {
        // Swallowed on purpose; see above.
      }
    };

    return ctx.logger.on("log.*", listener);
  }

  /**
   * Count one correlated trace record.
   *
   * `cpId` scopes the correlation key. OCPP message ids are only unique within
   * a connection, so in a multi-CP daemon two charge points can have
   * concurrent CALLs under the same id — without the scope the second would
   * overwrite the first, and the first answer would then be timed against the
   * wrong action and consume the entry the second answer needed.
   */
  observe(record: OcppTraceRecord, cpId = record.chargePointId ?? ""): void {
    const action = record.action ?? "unknown";
    bump(this.messages, `${action} ${record.direction}`);

    const atMs = Date.parse(record.timestamp);
    if (record.messageType === "CALL") {
      if (record.messageId && Number.isFinite(atMs)) {
        this.rememberCall(`${cpId}\u0000${record.messageId}`, action, atMs);
      }
      return;
    }

    if (record.messageType === "CALLERROR") bump(this.callErrors, action);
    if (!record.messageId) return;
    const key = `${cpId}\u0000${record.messageId}`;
    const call = this.pending.get(key);
    if (!call) return;
    this.pending.delete(key);
    if (!Number.isFinite(atMs)) return;
    this.observeDuration(call.action, (atMs - call.startedAtMs) / 1000);
  }

  /**
   * Count a SOAP wire line. Returns whether the line was one.
   *
   * Messages only — see {@link SOAP_REQUEST_PREFIX} for why there are no SOAP
   * durations.
   */
  private countSoapLine(message: string): boolean {
    if (message.startsWith(SOAP_REQUEST_PREFIX)) {
      const operation = soapOperation(message, SOAP_REQUEST_PREFIX);
      if (operation) bump(this.messages, `${operation} cp-to-csms`);
      return true;
    }
    if (message.startsWith(SOAP_RESPONSE_PREFIX)) {
      const operation = soapOperation(message, SOAP_RESPONSE_PREFIX);
      if (operation) bump(this.messages, `${operation} csms-to-cp`);
      return true;
    }
    return false;
  }

  countReconnect(): void {
    this.reconnects++;
  }

  countRpc(method: string, outcome: "ok" | "error"): void {
    bump(this.rpcRequests, `${method} ${outcome}`);
  }

  private rememberCall(
    messageId: string,
    action: string,
    startedAtMs: number,
  ): void {
    if (this.pending.size >= MAX_PENDING_CALLS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(messageId, { action, startedAtMs });
  }

  private observeDuration(action: string, seconds: number): void {
    // A negative delta means the clock moved, not that the call was instant.
    if (seconds < 0) return;
    let entry = this.callDurations.get(action);
    if (!entry) {
      entry = {
        buckets: new Array<number>(CALL_DURATION_BUCKETS_SECONDS.length).fill(
          0,
        ),
        sum: 0,
        count: 0,
      };
      this.callDurations.set(action, entry);
    }
    entry.sum += seconds;
    entry.count++;
    // Cumulative buckets: Prometheus `le` means "at most", so every bucket at
    // or above the observation is incremented.
    for (let i = 0; i < CALL_DURATION_BUCKETS_SECONDS.length; i++) {
      if (seconds <= CALL_DURATION_BUCKETS_SECONDS[i]!) entry.buckets[i]!++;
    }
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

let globalMetricsRecorder: MetricsRecorder | null = null;

export function setGlobalMetricsRecorder(
  recorder: MetricsRecorder | null,
): void {
  globalMetricsRecorder = recorder;
}

export function getGlobalMetricsRecorder(): MetricsRecorder | null {
  return globalMetricsRecorder;
}
