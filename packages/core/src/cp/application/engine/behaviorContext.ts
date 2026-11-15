import type {
  BehaviorCapability,
  BehaviorContext,
  ChargerSnapshot,
  ConnectorSnapshot,
  JsonObject,
  JsonValue,
  RandomStream,
  Behavior,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { OCPPStatus } from "../../domain/types/OcppTypes";
import type { DefaultResult } from "../../domain/engine/ChargePointEngine";
import { LogType } from "../../shared/Logger";
import { freezeParams } from "../behavior/paramsSchema";
import { RESERVED_PREFIX } from "./behaviorFit";
import type { ChargerState, NotifyKind } from "./ChargerState";
import { cannedResponse } from "./responseValidation";
import {
  BehaviorStopped,
  BehaviorTimeout,
  describe,
  type CallEnv,
  type Scope,
} from "./scope";

/** What a behavior context needs of its engine (the engine passes closures, so reassigned fields stay current). */
export interface BehaviorContextEngine {
  readonly host: ChargePoint;
  touch(): void;
  warn(message: string): void;
  readState(): ChargerState;
  runDefault(action: string, payload: unknown): DefaultResult;
  snapshotCharger(): ChargerSnapshot;
  snapshotConnector(id: number): ConnectorSnapshot | undefined;
  loadedBehavior(id: string): Behavior | undefined;
  paramsForContext(id: string): JsonObject;
  interceptDepth(): number;
  notifyStatus(kind: NotifyKind, status: string, requestId?: number): void;
}

export function makeBehaviorContext(
  engine: BehaviorContextEngine,
  behaviorId: string,
  scope: Scope,
  env?: CallEnv,
): BehaviorContext {
  const touch = (): void => engine.touch();
  const warn = (message: string): void => engine.warn(message);
  const readState = (): ChargerState => engine.readState();
  const runDefault = (action: string, req: unknown): DefaultResult =>
    engine.runDefault(action, req);
  const host = engine.host;
  const snapshotCharger = (): ChargerSnapshot => engine.snapshotCharger();
  const clock = host.clock;
  const behavior = engine.loadedBehavior(behaviorId);
  const requires = new Set(behavior?.requires ?? []);
  // Fixed for the life of the context: a CALL and its follow-up see the
  // params the CALL arrived with.
  const params = freezeParams(engine.paramsForContext(behaviorId));
  const needs = (capability: BehaviorCapability, what: string): void => {
    if (!requires.has(capability) && !behaviorId.startsWith("default.")) {
      throw new Error(
        `Behavior ${behaviorId} uses ${what} but does not list "${capability}" in requires`,
      );
    }
  };
  const stopped = (): Promise<never> => Promise.reject(new BehaviorStopped());
  // A context outlives its scope in a closure the behavior kept: once the
  // scope was cut off (unload, a grace time over, a closed connection for a
  // CALL's handler) it may no longer act on the station.
  const live = (): void => {
    if (scope.cancelled) throw new BehaviorStopped();
  };
  const connectorSnapshot = (id: number): ConnectorSnapshot | undefined =>
    engine.snapshotConnector(id);
  const ctx: BehaviorContext = {
    now: () => clock.now(),
    sleep: (ms: number): Promise<void> => {
      touch();
      if (scope.cancelled) return stopped();
      return new Promise<void>((resolve, reject) => {
        const handle = clock.setTimeout(() => {
          scope.untrack(handle);
          resolve();
        }, ms);
        scope.track(handle, () => {
          clock.clearTimeout(handle);
          reject(new BehaviorStopped());
        });
      });
    },
    until: <T>(promise: Promise<T>, opts: { ms: number }): Promise<T> => {
      touch();
      if (scope.cancelled) return stopped();
      return new Promise<T>((resolve, reject) => {
        const handle = clock.setTimeout(() => {
          scope.untrack(handle);
          reject(new BehaviorTimeout(opts.ms));
        }, opts.ms);
        scope.track(handle, () => {
          clock.clearTimeout(handle);
          reject(new BehaviorStopped());
        });
        promise.then(
          (value) => {
            clock.clearTimeout(handle);
            scope.untrack(handle);
            resolve(value);
          },
          (error: unknown) => {
            clock.clearTimeout(handle);
            scope.untrack(handle);
            reject(error);
          },
        );
      });
    },
    random(stream: string): RandomStream {
      const rng = host.rng(`${behaviorId}/${stream}`);
      // The contract's int() is inclusive at both ends; the core stream's
      // is [min, max).
      return {
        next: () => rng.next(),
        int: (minInclusive, maxInclusive) =>
          rng.int(minInclusive, maxInclusive + 1),
        pick: (items) => rng.pick(items),
        uuid: () => rng.uuid(),
      };
    },
    get stopping(): boolean {
      return scope.stopping;
    },
    get state(): Record<string, JsonValue> {
      const all = readState().behaviors;
      // A context kept past the unload of its behavior must not bring the
      // entry back (it would be stored again): it gets a loose object.
      if (
        scope.cancelled &&
        !behaviorId.startsWith(RESERVED_PREFIX) &&
        all[behaviorId] === undefined
      ) {
        return {};
      }
      return (all[behaviorId] ??= {});
    },
    send: async (action, payload, opts) => {
      touch();
      live();
      // From inside a beforeSend the CALL waits for its turn, so it goes
      // out after the CALL being intercepted.
      if (engine.interceptDepth() > 0) await Promise.resolve();
      live();
      const request = host.sendOcppCall({
        action,
        payload: payload as Record<string, unknown>,
      });
      if (opts?.fireAndForget) {
        request.catch((error: unknown) =>
          warn(`Behavior ${behaviorId}: ${action} failed: ${describe(error)}`),
        );
        return undefined;
      }
      const outcome = await request;
      if (outcome.kind === "callError") {
        throw new Error(
          `${action} was answered with ${outcome.errorCode}: ${outcome.errorDescription}`,
        );
      }
      return outcome.payload;
    },
    raw: (frame) => {
      needs("raw-frames", "ctx.raw");
      live();
      host
        .sendRawFrame({ frame })
        .catch((error: unknown) =>
          warn(`Behavior ${behaviorId}: raw frame failed: ${describe(error)}`),
        );
    },
    plugIn: (connectorId) => {
      needs("physical", "ctx.plugIn");
      live();
      // The cable model (#453): an idle Available connector reports
      // Preparing; in any other state the cable is only recorded.
      host.evPlugIn(connectorId);
    },
    unplug: (connectorId) => {
      needs("physical", "ctx.unplug");
      live();
      // The EV side of the cable: a running transaction is stopped or
      // suspended per StopTransactionOnEVSideDisconnect, as for any unplug.
      host.evDisconnected(connectorId);
    },
    authorize: (idTag) => {
      needs("physical", "ctx.authorize");
      live();
      host.authorize(idTag);
    },
    startCharging: (connectorId, idTag) => {
      needs("physical", "ctx.startCharging");
      live();
      host
        .startTransaction(host.resolveIdTag(idTag, connectorId), connectorId)
        .catch((error: unknown) =>
          warn(
            `Behavior ${behaviorId}: startCharging failed: ${describe(error)}`,
          ),
        );
    },
    stopCharging: (connectorId, reason) => {
      needs("physical", "ctx.stopCharging");
      live();
      const connector = host.getConnector(connectorId);
      if (connector?.transaction) {
        host.stopTransaction(connector, (reason ?? "Local") as never);
      }
    },
    setConnectorStatus: (connectorId, status) => {
      needs("physical", "ctx.setConnectorStatus");
      live();
      host.updateConnectorStatus(connectorId, status as OCPPStatus);
    },
    notify: {
      firmwareStatus: (status, opts) => {
        live();
        engine.notifyStatus("firmware", status, opts?.requestId);
      },
      signedFirmwareStatus: (status, requestId) => {
        live();
        engine.notifyStatus("signedFirmware", status, requestId);
      },
      logStatus: (status, opts) => {
        live();
        engine.notifyStatus("log", status, opts?.requestId);
      },
      diagnosticsStatus: (status) => {
        live();
        engine.notifyStatus("diagnostics", status);
      },
    },
    defaultBehavior: (req) => {
      if (!env || env.mode !== "extend") {
        throw new Error(
          "ctx.defaultBehavior is only available in an extend handler",
        );
      }
      const result = runDefault(env.action, req);
      if (result.effect) env.defaultEffects.push(result.effect);
      return result.response;
    },
    accepted: (action) => cannedResponse(action, host.ocppVersion, "accepted"),
    rejected: (action) => cannedResponse(action, host.ocppVersion, "rejected"),
    connector: connectorSnapshot,
    params,
    get charger(): ChargerSnapshot {
      return snapshotCharger();
    },
    log: (message) =>
      host.logger.info(`[behavior ${behaviorId}] ${message}`, LogType.OCPP),
  };
  return ctx;
}

/**
 * A read-only view of one connector: what `ctx.connector(id)` returns, and
 * what the scenario `$from` root `connector` reads (#654).
 */
export function snapshotConnectorOf(
  host: ChargePoint,
  id: number,
): ConnectorSnapshot | undefined {
  const connector = host.getConnector(id);
  if (!connector) return undefined;
  const point = connector.operatingPoint();
  return {
    id: connector.id,
    status: connector.status,
    availability: connector.availability,
    transactionId: connector.transaction
      ? (connector.transaction.cpTransactionId ?? connector.transaction.id)
      : null,
    idTag: connector.transaction?.tagId ?? null,
    power: {
      acceptedW: point.acceptedW,
      offeredW: point.offeredW,
      soc: point.soc,
      limitedBy: point.limitedBy,
    },
  };
}

/** A read-only view of the station: `ctx.charger`, and the `$from` root `charger`. */
export function snapshotChargerOf(host: ChargePoint): ChargerSnapshot {
  return {
    id: host.id,
    ocppVersion: host.ocppVersion,
    status: String(host.status),
    connectorIds: [...host.connectors.keys()],
  };
}
