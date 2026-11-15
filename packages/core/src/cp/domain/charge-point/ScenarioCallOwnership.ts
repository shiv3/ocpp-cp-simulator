import type { SimClock } from "../../shared/clock";

/** What the scenario call ownership needs from its charge point. */
export interface ScenarioCallOwnershipHost {
  readonly clock: () => SimClock;
}

/**
 * Transitional "parking" of CSMS-initiated RemoteStart/RemoteStop calls by
 * a running scenario (see docs/concepts/charger-engine.md#transitional).
 * Kept in one file so that removing it is a single-file deletion. The
 * charge point keeps the public methods as thin delegates.
 */
export class ScenarioCallOwnership {
  private readonly _scenarioHandledConnectors: Set<number> = new Set();
  // Mirror of _scenarioHandledConnectors but for the stop side. When a
  // connector id is in this set, the RemoteStopTransaction default
  // handler defers to the scenario instead of stopping the transaction
  // itself — the scenario is parked on a RemoteStopTrigger node and will
  // resume into its own Transaction Stop step.
  private readonly _scenarioStopHandledConnectors: Set<number> = new Set();
  // Diagnostic-only, paired with _scenarioHandledConnectors: whenever
  // RemoteStartTransaction lands via the DEFAULT path (no scenario armed on
  // this connector yet), the timestamp is recorded here. A scenario that
  // arms afterwards (registerScenarioHandler) consults this to detect that
  // it just missed a call that arrived while it was still walking toward
  // the trigger node — the "run_scenario raced RemoteStartTransaction"
  // footgun: the CSMS command silently starts a real transaction outside
  // the scenario, and the scenario then parks forever waiting for a call
  // that already happened. Consumed (deleted) on read via
  // takeDefaultHandledRemoteStart, so a warning never fires twice and a
  // stale/unrelated bypass can't leak into a later, unconnected run.
  private readonly _lastDefaultHandledRemoteStart: Map<number, number> =
    new Map();
  // Mirror of the above for the RemoteStopTransaction / stop-side bypass.
  private readonly _lastDefaultHandledRemoteStop: Map<number, number> =
    new Map();

  constructor(private readonly host: ScenarioCallOwnershipHost) {}

  register(connectorId: number): void {
    this._scenarioHandledConnectors.add(connectorId);
  }

  unregister(connectorId: number): void {
    this._scenarioHandledConnectors.delete(connectorId);
  }

  isHandled(connectorId: number): boolean {
    return this._scenarioHandledConnectors.has(connectorId);
  }

  noteDefaultHandledRemoteStart(connectorId: number): void {
    this._lastDefaultHandledRemoteStart.set(
      connectorId,
      this.host.clock().now(),
    );
  }

  takeDefaultHandledRemoteStart(
    connectorId: number,
    sinceMs: number,
  ): number | null {
    const ts = this._lastDefaultHandledRemoteStart.get(connectorId);
    this._lastDefaultHandledRemoteStart.delete(connectorId);
    return ts !== undefined && ts >= sinceMs ? ts : null;
  }

  registerStop(connectorId: number): void {
    this._scenarioStopHandledConnectors.add(connectorId);
  }

  unregisterStop(connectorId: number): void {
    this._scenarioStopHandledConnectors.delete(connectorId);
  }

  isStopHandled(connectorId: number): boolean {
    return this._scenarioStopHandledConnectors.has(connectorId);
  }

  noteDefaultHandledRemoteStop(connectorId: number): void {
    this._lastDefaultHandledRemoteStop.set(
      connectorId,
      this.host.clock().now(),
    );
  }

  takeDefaultHandledRemoteStop(
    connectorId: number,
    sinceMs: number,
  ): number | null {
    const ts = this._lastDefaultHandledRemoteStop.get(connectorId);
    this._lastDefaultHandledRemoteStop.delete(connectorId);
    return ts !== undefined && ts >= sinceMs ? ts : null;
  }

  /** Drop every parked connector and bypass record (connection closed). */
  clear(): void {
    this._scenarioHandledConnectors.clear();
    this._scenarioStopHandledConnectors.clear();
    this._lastDefaultHandledRemoteStart.clear();
    this._lastDefaultHandledRemoteStop.clear();
  }
}
