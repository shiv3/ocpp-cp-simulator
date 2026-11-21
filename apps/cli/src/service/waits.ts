import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import {
  waitForWireQuiet,
  WIRE_QUIET_MS,
  type WireQuietOutcome,
} from "@ocpp-cp-simulator/core/cp/application/verification/wireQuiet";
import type { CLIEvent, EventHandler } from "./cliEvents";

/**
 * Blocking waits for a driver of the control plane (#1090, #1091): wait for a
 * CLI event, for a scenario state, or for the wire to go quiet.
 */

export const WAIT_FOR_DEFAULT_MS = 20_000;
export const WAIT_QUIET_DEFAULT_MS = 10_000;

export interface WaitForRequest {
  readonly event?: string;
  readonly match?: Readonly<Record<string, unknown>>;
  readonly scenario?: {
    readonly connector: number;
    readonly scenarioId: string;
    readonly state: string;
  };
  readonly timeoutMs?: number;
}

export interface WaitForResult {
  readonly matched: boolean;
  readonly timedOut: boolean;
  readonly event?: string;
  readonly data?: unknown;
  readonly timestamp?: string;
  /** For a `scenario` wait: the status that matched. */
  readonly scenarioStatus?: unknown;
}

export interface WaitQuietRequest {
  readonly quietMs?: number;
  readonly timeoutMs?: number;
}

export interface WaitQuietResult extends WireQuietOutcome {
  readonly quiet: boolean;
}

export interface WaitSource {
  onEvent(handler: EventHandler): () => void;
  /** The scenario's current status, null when it is unknown. */
  readScenarioStatus(
    connectorId: number,
    scenarioId: string,
  ): { readonly state?: string } | null;
}

function dataMatches(
  data: unknown,
  match: Readonly<Record<string, unknown>>,
): boolean {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return Object.entries(match).every(
    ([key, want]) => JSON.stringify(record[key]) === JSON.stringify(want),
  );
}

export function eventMatches(
  evt: CLIEvent,
  request: WaitForRequest,
): boolean {
  if (request.scenario) {
    if (evt.event !== "scenario_state_changed") return false;
    const d = evt.data;
    return (
      d.connectorId === request.scenario.connector &&
      d.scenarioId === request.scenario.scenarioId &&
      d.state === request.scenario.state
    );
  }
  if (evt.event !== request.event) return false;
  return request.match === undefined || dataMatches(evt.data, request.match);
}

export function waitFor(
  source: WaitSource,
  request: WaitForRequest,
): Promise<WaitForResult> {
  const timeoutMs = request.timeoutMs ?? WAIT_FOR_DEFAULT_MS;
  return new Promise<WaitForResult>((resolve) => {
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: WaitForResult): void => {
      off?.();
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    // Subscribe before the state check, so a change between the two is seen.
    off = source.onEvent((evt) => {
      if (!eventMatches(evt, request)) return;
      finish({
        matched: true,
        timedOut: false,
        event: evt.event,
        data: evt.data,
        timestamp: new Date().toISOString(),
      });
    });
    if (request.scenario) {
      const status = source.readScenarioStatus(
        request.scenario.connector,
        request.scenario.scenarioId,
      );
      if (status?.state === request.scenario.state) {
        finish({ matched: true, timedOut: false, scenarioStatus: status });
        return;
      }
    }
    timer = setTimeout(
      () => finish({ matched: false, timedOut: true }),
      timeoutMs,
    );
  });
}

export async function waitQuiet(
  chargePoint: ChargePoint,
  request: WaitQuietRequest,
): Promise<WaitQuietResult> {
  const outcome = await waitForWireQuiet(chargePoint, {
    quietMs: request.quietMs ?? WIRE_QUIET_MS,
    maxMs: request.timeoutMs ?? WAIT_QUIET_DEFAULT_MS,
  });
  return { ...outcome, quiet: outcome.reason === "quiet" };
}
