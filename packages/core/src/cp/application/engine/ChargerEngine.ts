import type {
  Behavior,
  BehaviorCapability,
  BehaviorContext,
  CallBehavior,
  CallOutcome,
  ChargerSnapshot,
  ConnectorSnapshot,
  JsonValue,
  RandomStream,
} from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import { OCPPStatus } from "../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../domain/types/OcppVersion";
import { LogType } from "../../shared/Logger";
import type { SimClock, TimerHandle } from "../../shared/clock";
import type {
  BehaviorCall,
  BehaviorRule,
  HeldExchange,
  RuleOwner,
} from "../behavior/BehaviorRegistry";
import {
  assertJsonSerializable,
  initialChargerState,
  reduceChargerState,
  type ChargerState,
  type EngineEvent,
} from "./ChargerState";
import { registerDefaultBehaviors } from "./behaviors";
import { responseProblems } from "./responseValidation";

/** Thrown into a behavior's waits when it is unloaded or its connection ends. */
export class BehaviorStopped extends Error {
  constructor(message = "The behavior was stopped") {
    super(message);
    this.name = "BehaviorStopped";
  }
}

/** A `ctx.until` whose time ran out. */
export class BehaviorTimeout extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "BehaviorTimeout";
  }
}

export interface LoadBehaviorOptions {
  /**
   * Load without serving: no rule is registered and `main` does not start
   * until a scenario selects the behavior with `useBehavior`.
   */
  readonly dormant?: boolean;
}

/** What a default behavior produced for one CALL, in the shape handlers use. */
export interface DefaultResult {
  readonly response: unknown;
  /** Starts the work that follows the response; run it once the response settled. */
  readonly effect?: () => void;
}

/**
 * A set of waits that is cancelled together. A behavior's `main` has one for
 * the life of the behavior; each CALL a behavior or a default behavior answers
 * has one that also ends when the connection does.
 */
class Scope {
  stopping = false;
  private readonly cancels = new Map<TimerHandle, () => void>();

  constructor(
    readonly behaviorId: string,
    readonly connectionBound: boolean,
  ) {}

  track(handle: TimerHandle, cancel: () => void): void {
    this.cancels.set(handle, cancel);
  }

  untrack(handle: TimerHandle): void {
    this.cancels.delete(handle);
  }

  cancel(): void {
    this.stopping = true;
    for (const cancel of [...this.cancels.values()]) cancel();
    this.cancels.clear();
  }
}

/** Per-CALL data a context needs. */
interface CallEnv {
  readonly action: string;
  readonly mode: CallBehavior["mode"] | "default";
  /** Effects of default behaviors run through `ctx.defaultBehavior`. */
  readonly defaultEffects: Array<() => void>;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One per charge point (docs/analyses/charger-engine.md, "Charger engine").
 * It owns {@link ChargerState}, processes every event on one queue in order,
 * runs code behaviors and default behaviors against the same
 * {@link BehaviorContext}, and registers the rules of loaded behaviors with
 * the charge point's `BehaviorRegistry`.
 *
 * The queue is synchronous: an event dispatched while the queue is idle is
 * processed before `dispatch` returns, so a notification still goes out in the
 * turn that asked for it; one dispatched while an event is being processed
 * runs right after it.
 */
export class ChargerEngine {
  private _state: ChargerState = initialChargerState();
  private readonly queue: EngineEvent[] = [];
  private readonly connectors = new Map<number, Connector>();
  private draining = false;
  private disposed = false;
  private readonly loaded = new Map<string, Behavior>();
  /** Ids of behaviors loaded `dormant`. */
  private readonly dormant = new Set<string>();
  private readonly mainScopes = new Map<string, Scope>();
  private readonly callScopes = new Set<Scope>();
  private readonly defaults = new Map<
    string,
    { behavior: Behavior; call: CallBehavior }
  >();

  constructor(private readonly host: ChargePoint) {
    registerDefaultBehaviors(this, host);
  }

  /** The current state. Do not mutate it. */
  get state(): ChargerState {
    return this._state;
  }

  /** A deep copy of the state, checked to be JSON-serializable. */
  snapshot(): ChargerState {
    assertJsonSerializable(this._state);
    return JSON.parse(JSON.stringify(this._state)) as ChargerState;
  }

  /** Ids of the loaded code behaviors. */
  get behaviorIds(): readonly string[] {
    return [...this.loaded.keys()];
  }

  get clock(): SimClock {
    return this.host.clock;
  }

  // ---- the event queue ----------------------------------------------------

  dispatch(event: EngineEvent): void {
    // A connector write nests: the code that wrote `connector.status` (or
    // called `updateConnectorStatus`) did so synchronously, from inside
    // listeners of an earlier write, and the StatusNotification order on the
    // wire follows that nesting. Everything else runs in FIFO order.
    if (event.type.startsWith("connector.")) {
      this.processConnector(event);
      return;
    }
    this.queue.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        this.process(next);
      }
    } finally {
      this.draining = false;
    }
  }

  private processConnector(event: EngineEvent): void {
    const before = this._state;
    this._state = reduceChargerState(before, event);
    // Not guarded: an error a listener or the outbox throws reaches the caller
    // of the write, as it did before the engine owned the record.
    if (event.type === "connector.write")
      this.performConnectorWrite(event, before);
  }

  private performConnectorWrite(
    event: Extract<EngineEvent, { type: "connector.write" }>,
    before: ChargerState,
  ): void {
    const connector = this.connectors.get(event.connectorId);
    const previous = before.connectors[event.connectorId];
    if (!connector || !previous) return;
    connector.applyWrite(previous, event.write);
    const { write } = event;
    if (write.kind !== "status" || write.scope === "local") return;
    this.host.events.emit("connectorStatusChange", {
      connectorId: event.connectorId,
      status: write.status,
      previousStatus: previous.status,
    });
    if (write.scope === "full") {
      this.host.afterConnectorStatus(event.connectorId, write.status);
    }
  }

  /**
   * Put `connector`'s record into the engine state. From now on the
   * connector reads and writes it through the engine.
   */
  attachConnector(connector: Connector): void {
    const id = connector.id;
    this.connectors.set(id, connector);
    this.dispatch({
      type: "connector.added",
      connectorId: id,
      record: connector.record,
    });
    connector.bindStore({
      read: () => this._state.connectors[id] ?? connector.record,
      write: (write) =>
        this.dispatch({ type: "connector.write", connectorId: id, write }),
    });
  }

  /** The connector leaves: it keeps its last record in a cell of its own. */
  detachConnector(connectorId: number): void {
    const connector = this.connectors.get(connectorId);
    if (!connector) return;
    connector.bindStore(null, this._state.connectors[connectorId]);
    this.connectors.delete(connectorId);
    this.dispatch({ type: "connector.removed", connectorId });
  }

  private process(event: EngineEvent): void {
    this._state = reduceChargerState(this._state, event);
    try {
      this.perform(event);
    } catch (error) {
      this.warn(`Engine event ${event.type} failed: ${describe(error)}`);
    }
  }

  /** The side effects of an event, after the state took it. */
  private perform(event: EngineEvent): void {
    switch (event.type) {
      case "notified":
        switch (event.kind) {
          case "firmware":
            this.host.sendFirmwareStatusNotification(
              event.status as never,
              event.requestId,
            );
            break;
          case "signedFirmware":
            this.host.sendSignedFirmwareStatusNotification(
              event.status as never,
              event.requestId,
            );
            break;
          case "log":
            this.host.sendLogStatusNotification(
              event.status as never,
              event.requestId,
            );
            break;
          case "diagnostics":
            this.host.sendDiagnosticsStatusNotification(event.status as never);
            break;
        }
        break;
      case "connection.closed":
        for (const scope of [...this.callScopes]) {
          if (scope.connectionBound) this.endScope(scope);
        }
        break;
      case "disposed":
        this.disposed = true;
        for (const scope of [...this.callScopes]) this.endScope(scope);
        for (const scope of this.mainScopes.values()) scope.cancel();
        this.mainScopes.clear();
        break;
      default:
        break;
    }
  }

  private endScope(scope: Scope): void {
    scope.cancel();
    this.callScopes.delete(scope);
  }

  /** The connection ended: the work that followed its answers stops. */
  connectionClosed(): void {
    this.dispatch({ type: "connection.closed" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.dispatch({ type: "disposed" });
    this.host.behaviors.release((owner) => owner.kind === "code");
    this.loaded.clear();
  }

  // ---- code behaviors -----------------------------------------------------

  /**
   * Load a behavior: check its `requires`, register the rule of every
   * `onCall` entry, and start `main`. Throws on a duplicate id or a capability
   * this station cannot meet; nothing is registered then.
   */
  loadBehavior(behavior: Behavior, options: LoadBehaviorOptions = {}): void {
    if (behavior.api !== 1) {
      throw new Error(
        `Behavior ${behavior.id}: unsupported api ${String(behavior.api)}`,
      );
    }
    if (!behavior.id) throw new Error("A behavior needs an id");
    if (this.loaded.has(behavior.id)) {
      throw new Error(`Behavior ${behavior.id} is already loaded`);
    }
    for (const capability of behavior.requires ?? []) {
      const problem = this.unmet(capability);
      if (problem) {
        throw new Error(
          `Behavior ${behavior.id} requires ${capability}: ${problem}`,
        );
      }
    }
    if (!options.dormant) {
      this.registerRules(behavior, { kind: "code", behaviorId: behavior.id });
    }
    this.loaded.set(behavior.id, behavior);
    if (options.dormant) this.dormant.add(behavior.id);
    this.dispatch({ type: "behavior.loaded", behaviorId: behavior.id });
    if (behavior.main && !options.dormant) {
      const scope = new Scope(behavior.id, false);
      this.mainScopes.set(behavior.id, scope);
      this.runDetached(behavior.id, scope, (ctx) => behavior.main!(ctx));
    }
  }

  /**
   * Put the rules of a behavior loaded `dormant` to work under `owner` (a
   * scenario run, schema 1.5 `useBehavior`). The rules end with the owner:
   * release them with `BehaviorRegistry.release`. A behavior that is not
   * dormant already serves its rules; selecting it again does nothing. Throws
   * if no behavior has that id.
   */
  activateBehavior(id: string, owner: RuleOwner): void {
    const behavior = this.loaded.get(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    if (!this.dormant.has(id)) return;
    this.registerRules(behavior, owner);
  }

  private registerRules(behavior: Behavior, owner: RuleOwner): void {
    const unregister: Array<() => void> = [];
    try {
      for (const [action, call] of Object.entries(behavior.onCall ?? {})) {
        unregister.push(
          this.host.behaviors.register({
            owner,
            action,
            ...(call.match ? { match: call.match } : {}),
            mode: call.mode,
            ...(call.onBusy ? { onBusy: call.onBusy } : {}),
            take: (callInfo, exchange) =>
              this.runCall(behavior, call, callInfo, exchange),
          } satisfies BehaviorRule),
        );
      }
    } catch (error) {
      for (const off of unregister) off();
      throw error;
    }
  }

  /** Unload a behavior: stop its waits, release its rules, settle its open CALLs. */
  unloadBehavior(id: string): boolean {
    const behavior = this.loaded.get(id);
    if (!behavior) return false;
    this.loaded.delete(id);
    this.dormant.delete(id);
    this.mainScopes.get(id)?.cancel();
    this.mainScopes.delete(id);
    for (const scope of [...this.callScopes]) {
      if (scope.behaviorId === id) this.endScope(scope);
    }
    const open = this.host.behaviors.release(
      (owner) => owner.kind === "code" && owner.behaviorId === id,
    );
    for (const exchange of open) {
      this.warn(
        `Behavior ${id} was unloaded while ${exchange.action} was unanswered; answering InternalError`,
      );
      exchange.replyError("InternalError", `Behavior ${id} was unloaded`);
    }
    this.dispatch({ type: "behavior.unloaded", behaviorId: id });
    return true;
  }

  /** Run `onResume` of every loaded behavior; call it after state was restored. */
  resume(): void {
    for (const behavior of this.loaded.values()) {
      if (!behavior.onResume) continue;
      const scope = new Scope(behavior.id, false);
      this.mainScopes.set(`${behavior.id}#resume`, scope);
      this.runDetached(behavior.id, scope, (ctx) => behavior.onResume!(ctx));
    }
  }

  private unmet(capability: BehaviorCapability): string | null {
    const version = this.host.ocppVersion;
    switch (capability) {
      case "ocpp1.6":
        return version === "OCPP-1.6J" ? null : `the station speaks ${version}`;
      case "ocpp2.x":
        return isOcpp2Version(version) ? null : `the station speaks ${version}`;
      case "virtual-time":
        return "advanceBy" in this.host.clock
          ? null
          : "the station runs on real time";
      default:
        return null;
    }
  }

  private runDetached(
    behaviorId: string,
    scope: Scope,
    run: (ctx: BehaviorContext) => Promise<void>,
  ): void {
    const ctx = this.makeContext(behaviorId, scope);
    void Promise.resolve()
      .then(() => run(ctx))
      .catch((error: unknown) => {
        if (error instanceof BehaviorStopped) return;
        this.warn(`Behavior ${behaviorId} failed: ${describe(error)}`);
      });
  }

  // ---- answering a CALL ---------------------------------------------------

  /** A rule of a code behavior took the CALL. */
  private runCall(
    behavior: Behavior,
    call: CallBehavior,
    info: BehaviorCall,
    exchange: HeldExchange,
  ): void {
    const scope = new Scope(behavior.id, true);
    this.callScopes.add(scope);
    const env: CallEnv = {
      action: info.action,
      mode: call.mode,
      defaultEffects: [],
    };
    const ctx = this.makeContext(behavior.id, scope, env);
    const fail = (error: unknown): void => {
      this.endScope(scope);
      if (error instanceof BehaviorStopped) return;
      this.warn(
        `Behavior ${behavior.id} failed on ${info.action}: ${describe(error)}`,
      );
      if (exchange.state === "open") {
        exchange.replyError("InternalError", describe(error).slice(0, 255));
      }
    };
    const finish = (outcome: CallOutcome): void => {
      try {
        this.answer(behavior.id, scope, ctx, env, info, exchange, outcome);
      } catch (error) {
        fail(error);
      }
    };
    let handled: CallOutcome | Promise<CallOutcome>;
    try {
      handled = call.handle(info.payload, ctx);
    } catch (error) {
      fail(error);
      return;
    }
    // Only a real promise defers the answer: a synchronous handler answers in
    // the turn the CALL arrived (#456).
    if (isThenable(handled)) {
      Promise.resolve(handled).then(finish, fail);
    } else {
      finish(handled);
    }
  }

  private answer(
    behaviorId: string,
    scope: Scope,
    ctx: BehaviorContext,
    env: CallEnv,
    info: BehaviorCall,
    exchange: HeldExchange,
    outcome: CallOutcome,
  ): void {
    if (exchange.state !== "open" && exchange.state !== "abandoned") {
      this.endScope(scope);
      return;
    }
    const afterUser = outcome.after;
    const effect = (): void => {
      for (const defaultEffect of env.defaultEffects) defaultEffect();
      if (afterUser) {
        this.runAfter(behaviorId, scope, ctx, afterUser);
      } else {
        this.endScope(scope);
      }
    };
    const dropped = (reason: string): void => {
      this.warn(
        `Behavior ${behaviorId}: the answer to ${info.action} was not delivered (${reason}); its follow-up is skipped`,
      );
      this.endScope(scope);
    };
    if ("noResponse" in outcome) {
      void exchange.suppress();
      effect();
      return;
    }
    if ("error" in outcome) {
      exchange.replyError(outcome.error.code, outcome.error.description, {
        effect,
        onEffectDropped: dropped,
      });
      return;
    }
    if (!outcome.skipValidation) {
      const problems = responseProblems(
        info.action,
        this.host.ocppVersion,
        outcome.response,
      );
      if (problems.length > 0) {
        this.warn(
          `Behavior ${behaviorId} produced an invalid ${info.action} response: ${problems.join("; ")}`,
        );
        this.endScope(scope);
        exchange.replyError(
          "InternalError",
          `Invalid ${info.action} response from behavior ${behaviorId}`.slice(
            0,
            255,
          ),
        );
        return;
      }
    }
    exchange.reply(outcome.response, { effect, onEffectDropped: dropped });
  }

  private runAfter(
    behaviorId: string,
    scope: Scope,
    ctx: BehaviorContext,
    after: () => Promise<void>,
  ): void {
    // Started in the turn the response settled (as the effects it replaces
    // were), up to its first wait.
    let running: Promise<void>;
    try {
      running = Promise.resolve(after());
    } catch (error) {
      running = Promise.reject(error);
    }
    void running
      .catch((error: unknown) => {
        if (error instanceof BehaviorStopped) return;
        this.warn(
          `Behavior ${behaviorId}: follow-up failed: ${describe(error)}`,
        );
      })
      .finally(() => this.endScope(scope));
    void ctx;
  }

  // ---- default behaviors --------------------------------------------------

  /** Register the behaviors that answer when no user behavior does. */
  registerDefault(behavior: Behavior): void {
    for (const [action, call] of Object.entries(behavior.onCall ?? {})) {
      this.defaults.set(action, { behavior, call });
    }
    this.dispatch({ type: "behavior.loaded", behaviorId: behavior.id });
  }

  /** Does a default behavior answer `action`? */
  hasDefault(action: string): boolean {
    return this.defaults.has(action);
  }

  /**
   * Run the default behavior of `action` for a request that reached the
   * default path. Written for the handlers: the response, and the effect that
   * starts the follow-up once the response settled.
   */
  runDefault(action: string, payload: unknown): DefaultResult {
    const entry = this.defaults.get(action);
    if (!entry) throw new Error(`No default behavior answers ${action}`);
    const scope = new Scope(entry.behavior.id, true);
    this.callScopes.add(scope);
    const env: CallEnv = { action, mode: "default", defaultEffects: [] };
    const ctx = this.makeContext(entry.behavior.id, scope, env);
    let outcome: CallOutcome | Promise<CallOutcome>;
    try {
      outcome = entry.call.handle(payload, ctx);
    } catch (error) {
      this.endScope(scope);
      throw error;
    }
    if (isThenable(outcome)) {
      this.endScope(scope);
      throw new Error(
        `Default behavior of ${action} must answer synchronously`,
      );
    }
    if (!("response" in outcome)) {
      this.endScope(scope);
      throw new Error(
        `Default behavior of ${action} did not produce a response`,
      );
    }
    const after = outcome.after;
    if (!after) {
      this.endScope(scope);
      return { response: outcome.response };
    }
    return {
      response: outcome.response,
      effect: () => this.runAfter(entry.behavior.id, scope, ctx, after),
    };
  }

  // ---- the context --------------------------------------------------------

  private makeContext(
    behaviorId: string,
    scope: Scope,
    env?: CallEnv,
  ): BehaviorContext {
    const dispatch = (event: EngineEvent): void => this.dispatch(event);
    const warn = (message: string): void => this.warn(message);
    const readState = (): ChargerState => this._state;
    const runDefault = (action: string, req: unknown): DefaultResult =>
      this.runDefault(action, req);
    const host = this.host;
    const clock = host.clock;
    const behavior = this.loaded.get(behaviorId);
    const requires = new Set(behavior?.requires ?? []);
    const needs = (capability: BehaviorCapability, what: string): void => {
      if (!requires.has(capability) && !behaviorId.startsWith("default.")) {
        throw new Error(
          `Behavior ${behaviorId} uses ${what} but does not list "${capability}" in requires`,
        );
      }
    };
    const stopped = (): Promise<never> => Promise.reject(new BehaviorStopped());
    const connectorSnapshot = (id: number): ConnectorSnapshot | undefined => {
      const connector = host.getConnector(id);
      if (!connector) return undefined;
      return {
        id: connector.id,
        status: connector.status,
        availability: connector.availability,
        transactionId: connector.transaction?.id ?? null,
        idTag: connector.transaction?.tagId ?? null,
      };
    };
    const ctx: BehaviorContext = {
      now: () => clock.now(),
      sleep(ms: number): Promise<void> {
        if (scope.stopping) return stopped();
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
      until<T>(promise: Promise<T>, opts: { ms: number }): Promise<T> {
        if (scope.stopping) return stopped();
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
        return host.rng(`${behaviorId}/${stream}`);
      },
      get stopping(): boolean {
        return scope.stopping;
      },
      get state(): Record<string, JsonValue> {
        return (readState().behaviors[behaviorId] ??= {});
      },
      send: async (action, payload, opts) => {
        const request = host.sendOcppCall({
          action,
          payload: payload as Record<string, unknown>,
        });
        if (opts?.fireAndForget) {
          request.catch((error: unknown) =>
            warn(
              `Behavior ${behaviorId}: ${action} failed: ${describe(error)}`,
            ),
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
        host
          .sendRawFrame({ frame })
          .catch((error: unknown) =>
            warn(
              `Behavior ${behaviorId}: raw frame failed: ${describe(error)}`,
            ),
          );
      },
      plugIn: (connectorId) => {
        needs("physical", "ctx.plugIn");
        host.updateConnectorStatus(connectorId, OCPPStatus.Preparing);
      },
      unplug: (connectorId) => {
        needs("physical", "ctx.unplug");
        host.updateConnectorStatus(connectorId, OCPPStatus.Available);
      },
      authorize: (idTag) => {
        needs("physical", "ctx.authorize");
        host.authorize(idTag);
      },
      startCharging: (connectorId, idTag) => {
        needs("physical", "ctx.startCharging");
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
        const connector = host.getConnector(connectorId);
        if (connector?.transaction) {
          host.stopTransaction(connector, (reason ?? "Local") as never);
        }
      },
      setConnectorStatus: (connectorId, status) => {
        needs("physical", "ctx.setConnectorStatus");
        host.updateConnectorStatus(connectorId, status as OCPPStatus);
      },
      notify: {
        firmwareStatus: (status, opts) =>
          dispatch({
            type: "notified",
            kind: "firmware",
            status,
            ...(opts?.requestId === undefined
              ? {}
              : { requestId: opts.requestId }),
          }),
        signedFirmwareStatus: (status, requestId) =>
          dispatch({
            type: "notified",
            kind: "signedFirmware",
            status,
            requestId,
          }),
        logStatus: (status, opts) =>
          dispatch({
            type: "notified",
            kind: "log",
            status,
            ...(opts?.requestId === undefined
              ? {}
              : { requestId: opts.requestId }),
          }),
        diagnosticsStatus: (status) =>
          dispatch({ type: "notified", kind: "diagnostics", status }),
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
      connector: connectorSnapshot,
      get charger(): ChargerSnapshot {
        return {
          id: host.id,
          ocppVersion: host.ocppVersion,
          status: String(host.status),
          connectorIds: [...host.connectors.keys()],
        };
      },
      log: (message) =>
        host.logger.info(`[behavior ${behaviorId}] ${message}`, LogType.OCPP),
    };
    return ctx;
  }

  private warn(message: string): void {
    this.host.logger.warn(message, LogType.OCPP);
  }
}
