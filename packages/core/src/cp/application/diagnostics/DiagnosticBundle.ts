import {
  redactSensitiveText,
  redactSensitiveValue,
} from "../../shared/redaction";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { createStoredZip, type ZipEntry } from "./zip";
import { summarizeScenarios } from "./scenarioReadModel";
import { collectLogLines } from "./logLines";

/** Version of the bundle layout (`manifest.json` `schemaVersion`). */
export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;
/** The file name a bundle upload announces and uses. */
export const DIAGNOSTIC_BUNDLE_FILE_NAME = "diagnostics.zip";

export interface DiagnosticBundleLimits {
  readonly logBytes: number;
  readonly traceBytes: number;
  /** Per scenario definition. */
  readonly scenarioBytes: number;
}
export const DEFAULT_BUNDLE_LIMITS: DiagnosticBundleLimits = {
  logBytes: 1024 * 1024,
  traceBytes: 1024 * 1024,
  scenarioBytes: 256 * 1024,
};

/** The request a bundle answers, as the manifest records it. */
export interface BundleRequestInfo {
  readonly action: "GetDiagnostics" | "GetLog";
  readonly requestId?: number;
  readonly logType?: string;
  readonly oldestTimestamp?: string;
  readonly latestTimestamp?: string;
}

export interface BundlePartInfo {
  readonly present: boolean;
  readonly bytes?: number;
  readonly entries?: number;
  /** Entries left out for the size bound (the oldest). */
  readonly truncated?: number;
  /** Why an absent or reduced part is so. */
  readonly omitted?: string;
}

export interface DiagnosticBundle {
  readonly file: File;
  readonly manifest: Record<string, unknown>;
  /** Every part as the JSON it was serialized from, by file name. */
  readonly parts: Readonly<Record<string, string>>;
}

/** Substrings that make a configuration key a secret (case-insensitive). */
const SECRET_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "privatekey",
  "authorizationkey",
  "apikey",
  "pin",
  "credential",
  "certificate",
  "cert",
];

/** True when the configuration key's value must not leave the station. */
export function isSecretConfigKey(name: string): boolean {
  const n = name.replace(/[-_.\s]/g, "").toLowerCase();
  return SECRET_KEY_PARTS.some((part) => n.includes(part));
}

const REDACTED = "[redacted]";

/** One configuration value, redacted by the single policy of the bundle:
 *  secret key names, PEM material and credential-looking text. */
export function redactConfigValue(name: string, value: unknown): unknown {
  if (isSecretConfigKey(name)) {
    return value === "" || value === null || value === undefined
      ? value
      : REDACTED;
  }
  if (typeof value === "string") {
    if (value.includes("-----BEGIN")) return REDACTED;
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactConfigValue("", v));
  }
  return redactSensitiveValue(value);
}

const MASK = "[redacted]";

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** `configuration.json`: effective values, which are persisted, nothing staged. */
function configurationPart(cp: ChargePoint): Record<string, unknown> {
  const persisted = new Set(cp.configuration.persistedOverrideKeys());
  const effective = cp.configuration.all().map((entry) => ({
    name: entry.key.name,
    value: redactConfigValue(entry.key.name, entry.value),
    type: entry.key.type,
    readonly: entry.key.readonly,
    state: persisted.has(entry.key.name) ? "persisted-override" : "default",
  }));
  return {
    effective,
    // ChangeConfiguration / SetVariables apply at once in the simulator, also
    // for keys it answers RebootRequired for: no value waits for a restart.
    staged: [],
    notes: [
      "state: persisted-override = changed from the default and stored; default = the simulator's default",
      "staged: values accepted but not yet active; the simulator has none",
      "values of keys named like a password, secret, token, key or certificate are redacted",
    ],
  };
}

function stationStatePart(cp: ChargePoint): Record<string, unknown> {
  const connectors = [...cp.connectors.values()].map((c) => {
    const tx = c.transaction;
    return {
      id: c.id,
      status: c.status,
      availability: c.availability,
      scheduledAvailability: c.scheduledAvailability,
      errorCode: c.currentErrorCode,
      errorInfo: c.errorInfo,
      evConnection: c.evConnection,
      meterValueWh: c.meterValue,
      soc: c.soc,
      transaction: tx
        ? {
            id: tx.id,
            cpTransactionId: tx.cpTransactionId ?? null,
            idTag: MASK,
            meterStartWh: tx.meterStart,
            meterStopWh: tx.meterStop,
            startTime: isoOrNull(tx.startTime),
            stopTime: isoOrNull(tx.stopTime),
          }
        : null,
    };
  });
  const modem = cp.modem;
  return {
    chargePoint: {
      id: cp.id,
      status: cp.status,
      error: cp.error,
      ocppVersion: cp.ocppVersion,
      transport: cp.isSoapChargePoint() ? "soap" : "websocket",
      connected: cp.isWebSocketConnected,
      bootAccepted: cp.bootAccepted,
      poweredOff: cp.poweredOff,
      connectorCount: cp.connectorNumber,
    },
    connectors,
    // Bounded, and never the raw network-simulation or modem state; ICCID and
    // IMSI are masked (#925 comment, #928).
    connectivity: redactSensitiveValue({
      networkInterface: modem?.networkInterface ?? null,
      modem: modem ? modem.redacted() : null,
      networkSim: cp.networkSimSummary(),
      webSocketConnected: cp.isWebSocketConnected,
    }),
  };
}

function scenarioParts(
  cp: ChargePoint,
  limits: DiagnosticBundleLimits,
): { scenario: Record<string, unknown>; run: Record<string, unknown> } {
  const src = cp.diagnosticsSources.scenarios;
  const summary = summarizeScenarios(src);
  if (!src) {
    const reason = "no scenario runtime is attached to this station";
    return {
      scenario: { available: false, reason },
      run: { available: false, reason, status: "unavailable", runs: [] },
    };
  }
  const running = summary.runs.map((r) => {
    const raw = src.definition(r.scenarioId);
    if (raw === undefined) {
      return { runId: r.runId, scenarioId: r.scenarioId, definition: null };
    }
    const json = JSON.stringify(redactSensitiveValue(raw));
    if (json.length > limits.scenarioBytes) {
      return {
        runId: r.runId,
        scenarioId: r.scenarioId,
        definition: null,
        omitted: `definition is ${json.length} bytes, over the ${limits.scenarioBytes} byte bound`,
      };
    }
    return {
      runId: r.runId,
      scenarioId: r.scenarioId,
      definition: JSON.parse(json) as unknown,
    };
  });
  return {
    scenario: {
      available: true,
      // The simulator has no scenario selection yet (#569): no selected
      // scenario is invented. The scenarios of the runs in progress follow.
      selected: null,
      installed: src.installed().map((s) => ({ ...s })),
      running,
    },
    run: {
      available: true,
      // "idle" means no run is in progress; a finished run is only ever
      // `lastRun`, never mixed with the active ones.
      status: summary.status,
      runCount: summary.runs.length,
      runs: summary.runs.map((r) => ({ ...r })),
      lastRun: summary.lastRun,
    },
  };
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/**
 * The shared diagnostic bundle generator (#925): one point-in-time snapshot of
 * the station as a ZIP of `manifest.json`, `configuration.json`,
 * `station-state.json`, `scenario.json`, `scenario-run.json`, `logs.jsonl` and,
 * when the host has a trace source, `ocpp-trace.jsonl`. Everything is read
 * synchronously in one go, so the parts describe the same moment; the upload
 * that follows (and its retries) sends these bytes unchanged.
 */
export function buildDiagnosticBundle(
  cp: ChargePoint,
  request: BundleRequestInfo,
  limits: DiagnosticBundleLimits = DEFAULT_BUNDLE_LIMITS,
): DiagnosticBundle {
  const now = new Date(cp.clock.now());
  const sources = cp.diagnosticsSources;
  const configuration = json(configurationPart(cp));
  const state = json(stationStatePart(cp));
  const { scenario, run } = scenarioParts(cp, limits);
  const logs = collectLogLines(cp, request, limits.logBytes);
  const parts: Record<string, string> = {
    "configuration.json": configuration,
    "station-state.json": state,
    "scenario.json": json(scenario),
    "scenario-run.json": json(run),
    "logs.jsonl": logs.text,
  };
  const info: Record<string, BundlePartInfo> = {
    "configuration.json": { present: true, bytes: configuration.length },
    "station-state.json": { present: true, bytes: state.length },
    "scenario.json": {
      present: true,
      ...(scenario.available === false
        ? { omitted: "no scenario runtime" }
        : {}),
    },
    "scenario-run.json": {
      present: true,
      ...(run.available === false ? { omitted: "no scenario runtime" } : {}),
    },
    "logs.jsonl": {
      present: true,
      entries: logs.entries,
      ...(logs.truncated > 0 ? { truncated: logs.truncated } : {}),
    },
  };
  if (cp.isSoapChargePoint()) {
    info["ocpp-trace.jsonl"] = {
      present: false,
      omitted: "OCPP-S (SOAP) traces are not supported",
    };
  } else if (!sources.traceLines) {
    info["ocpp-trace.jsonl"] = {
      present: false,
      omitted: "no trace source is attached to this station",
    };
  } else {
    const trace = collectTrace(
      sources.traceLines(),
      request,
      limits.traceBytes,
    );
    parts["ocpp-trace.jsonl"] = trace.text;
    info["ocpp-trace.jsonl"] = {
      present: true,
      entries: trace.entries,
      ...(trace.truncated > 0 ? { truncated: trace.truncated } : {}),
    };
  }
  for (const [name, text] of Object.entries(parts)) {
    info[name] = {
      ...info[name]!,
      bytes: new TextEncoder().encode(text).length,
    };
  }
  const manifest = {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    chargePointId: cp.id,
    ocppVersion: cp.ocppVersion,
    transport: cp.isSoapChargePoint() ? "soap" : "websocket",
    simulatorVersion: sources.simulatorVersion ?? null,
    request: { ...request },
    redaction: {
      policy: "v1",
      description:
        "secrets, passwords, tokens, private keys, certificates and authorization data are replaced by [redacted]; SIM identifiers are masked",
    },
    parts: info,
  };
  const manifestText = json(manifest);
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: "manifest.json", data: encoder.encode(manifestText) },
    ...Object.entries(parts).map(([name, text]) => ({
      name,
      data: encoder.encode(text),
    })),
  ];
  const bytes = createStoredZip(entries, now);
  return {
    file: new File([bytes], DIAGNOSTIC_BUNDLE_FILE_NAME, {
      type: "application/zip",
    }),
    manifest,
    parts: { "manifest.json": manifestText, ...parts },
  };
}

/** The trace lines inside the request's window, newest kept within the bound. */
function collectTrace(
  lines: ReadonlyArray<string>,
  window: BundleRequestInfo,
  maxBytes: number,
): { text: string; entries: number; truncated: number } {
  const from = window.oldestTimestamp
    ? Date.parse(window.oldestTimestamp)
    : NaN;
  const to = window.latestTimestamp ? Date.parse(window.latestTimestamp) : NaN;
  const inside = lines.filter((line) => {
    if (Number.isNaN(from) && Number.isNaN(to)) return true;
    let at: number;
    try {
      const rec = JSON.parse(line) as { timestamp?: unknown; time?: unknown };
      at = Date.parse(String(rec.timestamp ?? rec.time ?? ""));
    } catch {
      return true;
    }
    if (Number.isNaN(at)) return true;
    return (Number.isNaN(from) || at >= from) && (Number.isNaN(to) || at <= to);
  });
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (let i = inside.length - 1; i >= 0; i--) {
    const line = redactSensitiveText(inside[i]!);
    const size = encoder.encode(line).length + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.unshift(line);
  }
  return {
    text: kept.length ? kept.join("\n") + "\n" : "",
    entries: kept.length,
    truncated: inside.length - kept.length,
  };
}
