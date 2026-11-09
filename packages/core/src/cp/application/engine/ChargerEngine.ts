import type {
  Behavior,
  BehaviorCapability,
  BehaviorEvents,
  BehaviorContext,
  CallBehavior,
  CallOutcome,
  ChargerSnapshot,
  ConnectorSnapshot,
  JsonObject,
  JsonValue,
  RandomStream,
  TransactionEvent,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import type {
  ConnectorRecord,
  ConnectorWrite,
} from "../../domain/connector/ConnectorRecord";
import { isAllowedConnectorStatusTransition } from "../../domain/connector/ConnectorTransitions";
import type { OCPPStatus } from "../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../domain/types/OcppVersion";
import {
  RESERVED_PREFIX,
  behaviorFitProblem,
  behaviorShapeProblem,
} from "./behaviorFit";
import { LogType } from "../../shared/Logger";
import type { SimClock, TimerHandle } from "../../shared/clock";
import { csmsActionAliases } from "../../domain/types/csmsActionNames";
import { ruleKey, ruleOwnerKey } from "../behavior/BehaviorRegistry";
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
  type PersistedEngineState,
  type EngineEvent,
  type NotifyKind,
} from "./ChargerState";
import type {
  BeforeSendResult,
  ChargePointEngine,
  DefaultResult,
  EngineObservation,
  LoadBehaviorOptions,
} from "../../domain/engine/ChargePointEngine";
import { registerDefaultBehaviors } from "./behaviors";
import {
  EMPTY_PARAMS,
  freezeParams,
  mergeParams,
} from "../behavior/paramsSchema";
import { cannedResponse, responseProblems } from "./responseValidation";

/** Ids with this prefix belong to the built-in behaviors; none can be loaded. */

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

/**
 * A set of waits that is cancelled together. A behavior's `main` has one for
 * the life of the behavior; each CALL a behavior or a default behavior answers
 * has one that also ends when the connection does.
 */
class Scope {
  /** `ctx.stopping`: the owner asked the work to wind down. */
  stopping = false;
  /** Waits reject: the work is cut off. A scope can be stopping a while before. */
  cancelled = false;
  private readonly cancels = new Map<TimerHandle, () => void>();

  constructor(
    readonly behaviorId: string,
    public connectionBound: boolean,
  ) {}

  track(handle: TimerHandle, cancel: () => void): void {
    this.cancels.set(handle, cancel);
  }

  untrack(handle: TimerHandle): void {
    this.cancels.delete(handle);
  }

  /** Ask the work to finish (`ctx.stopping` turns true); its waits keep working. */
  requestStop(): void {
    this.stopping = true;
  }

  cancel(): void {
    this.stopping = true;
    this.cancelled = true;
    for (const cancel of [...this.cancels.values()]) cancel();
    this.cancels.clear();
  }
}

/**
 * Default behaviors whose follow-up stops when the connection closes: the
 * firmware status trains, whose timers `ChargePoint` cleared on a close before
 * the engine. The log and diagnostics uploads were not tied to the socket and
 * go on across a reconnect. Rule 4 of docs/concepts/charger-engine.md: this is
 * the behavior of ca01d302, kept as it was.
 */
const CONNECTION_BOUND_DEFAULTS: ReadonlySet<string> = new Set([
  "default.firmware",
  "default.signedFirmware",
]);

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

function jsonCopy(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One per charge point (docs/concepts/charger-engine.md, "Charger engine").
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
export class ChargerEngine implements ChargePointEngine {
  private _state: ChargerState = initialChargerState();
  private readonly queue: EngineEvent[] = [];
  private readonly connectors = new Map<number, Connector>();
  private draining = false;
  private disposed = false;
  private readonly loaded = new Map<string, Behavior>();
  /** Ids of behaviors loaded `dormant`. */
  private readonly dormant = new Set<string>();
  /**
   * Owners (by key) that selected a dormant behavior, per behavior id. A
   * dormant behavior is fully active, with its `onCall` rules, `main`, `on`
   * hooks and `beforeSend`, while at least one owner holds it, and fully idle
   * otherwise (`onResume` aside: a dormant behavior never resumes).
   */
  private readonly holders = new Map<string, Map<string, RuleOwner>>();
  private readonly mainScopes = new Map<string, Scope>();
  /** The scope of each behavior's `onResume`. */
  private readonly resumeScopes = new Map<string, Scope>();
  /** The promise of each running `main`, for a reload to wait on. */
  private readonly mainRuns = new Map<string, Promise<void>>();
  /** A reload waiting out the grace time of the old `main`: cancels the wait. */
  private readonly pendingMains = new Map<string, () => void>();
  private readonly callScopes = new Set<Scope>();
  private readonly defaults = new Map<
    string,
    { behavior: Behavior; call: CallBehavior }
  >();
  /** The default behaviors by id (the action table above is keyed by action). */
  private readonly defaultsById = new Map<string, Behavior>();
  /**
   * Params the station's selection set, per behavior id (default or loaded).
   * Set by `cp.behaviors.set`, `cp.create` and `--behavior-params`.
   */
  private readonly selectionParams = new Map<string, JsonObject>();
  /**
   * Params a scenario run set with `useBehavior`, per behavior id and owner,
   * oldest first. They sit on top of the selection's and end with the run.
   */
  private readonly paramLayers = new Map<
    string,
    Map<string, { owner: RuleOwner; params: JsonObject }>
  >();

  /** True while a loaded, non-dormant behavior has a `beforeSend` table. */
  private intercepting = false;
  /** >0 while a `beforeSend` function runs. */
  private interceptDepth = 0;
  /** Event hooks waiting for delivery, oldest first. */
  private readonly hookQueue: Array<{
    name: keyof BehaviorEvents;
    /** The event, or a function that builds it at delivery. */
    event: unknown;
  }> = [];
  private hookScheduled = false;
  private hookDraining = false;
  /** True while a loaded, non-dormant behavior has an `on` table. */
  private hooked = false;
  /** The context (and wait scope) each behavior's hooks run with. */
  private readonly hookContexts = new Map<
    string,
    { scope: Scope; ctx: BehaviorContext }
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

  // ---- persistence --------------------------------------------------------

  /**
   * `ctx.state` read back from storage for behaviors that are not loaded (yet).
   * A behavior loaded later adopts its entry; one that never comes back keeps
   * its entry in {@link persistable}, so dropping `--behavior` for one run does
   * not lose its data.
   */
  private orphans: Record<string, Record<string, JsonValue>> = {};
  private persistListener: (() => void) | null = null;
  private readonly lastGoodState: Record<string, Record<string, JsonValue>> =
    Object.create(null) as Record<string, Record<string, JsonValue>>;
  private readonly badState = new Set<string>();

  /**
   * The part of the state that survives a restart. A deep copy; throws if a
   * behavior put something into `ctx.state` that is not JSON.
   */
  persistable(): PersistedEngineState {
    const { schema, firmware, signedFirmware, log, diagnostics, behaviors } =
      this._state;
    // The built-in defaults keep no user data worth storing. Each behavior's
    // entry is checked on its own: one that put something into `ctx.state` that
    // is not JSON keeps its last saved value, and the rest of the station's
    // state is stored all the same.
    const user: Record<string, Record<string, JsonValue>> = {};
    for (const [id, data] of Object.entries(behaviors)) {
      if (id.startsWith("default.")) continue;
      try {
        assertJsonSerializable(data, `ctx.state of ${id}`);
        user[id] = data;
        this.lastGoodState[id] = JSON.parse(JSON.stringify(data)) as Record<
          string,
          JsonValue
        >;
        this.badState.delete(id);
      } catch (error) {
        if (!this.badState.has(id)) {
          this.badState.add(id);
          this.warn(
            `Behavior ${id}: ${describe(error)}; its ctx.state keeps the last value that could be stored`,
          );
        }
        const kept = this.lastGoodState[id];
        if (kept) user[id] = kept;
      }
    }
    // An entry still waiting to be adopted by a behavior that is loading is the
    // stored one, not the empty object the load just created.
    const state = {
      schema,
      firmware,
      signedFirmware,
      log,
      diagnostics,
      behaviors: { ...user, ...this.orphans },
    };
    assertJsonSerializable(state);
    return JSON.parse(JSON.stringify(state)) as PersistedEngineState;
  }

  /**
   * Throws if the `ctx.state` of a user behavior holds something that is not
   * JSON (a `Date`, a `Map`, a function, `NaN`). The daemon only warns, so a
   * station keeps running; a test harness calls this so the slip fails the test.
   */
  assertStorableState(): void {
    for (const [id, data] of Object.entries(this._state.behaviors)) {
      if (id.startsWith(RESERVED_PREFIX)) continue;
      assertJsonSerializable(data, `ctx.state of ${id}`);
    }
  }

  /**
   * Called when the persistable state may have changed: after a status
   * notification, and every time a behavior yields to the engine (a wait, a
   * send, the end of a handler), which is when its `ctx.state` writes settle.
   * The listener compares and stores; it must not throw.
   */
  onPersist(listener: (() => void) | null): void {
    this.persistListener = listener;
  }

  private touch(): void {
    if (!this.persistListener) return;
    try {
      this.persistListener();
    } catch (error) {
      this.warn(`Persisting the engine state failed: ${describe(error)}`);
    }
  }

  /**
   * Put stored state back: the notification statuses (nothing is sent) and the
   * `ctx.state` of every behavior, in place, so a behavior that already holds
   * its `ctx.state` object sees it. Call it before `resume()`.
   */
  restoreState(saved: PersistedEngineState): void {
    this.dispatch({
      type: "state.restored",
      firmware: saved.firmware,
      signedFirmware: saved.signedFirmware,
      log: saved.log,
      diagnostics: saved.diagnostics,
    });
    this.orphans = {};
    for (const [id, data] of Object.entries(saved.behaviors)) {
      if (!this.adoptState(id, data)) this.orphans[id] = data;
    }
  }

  /** Replace the `ctx.state` of a loaded behavior in place; false if none. */
  private adoptState(id: string, data: Record<string, JsonValue>): boolean {
    if (!Object.hasOwn(this._state.behaviors, id)) return false;
    const target = this._state.behaviors[id]!;
    for (const key of Object.keys(target)) delete target[key];
    // Own properties, not assignments: a stored key named `__proto__` must not
    // reach the setter.
    for (const [key, value] of Object.entries(data)) {
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return true;
  }

  /** The loaded behavior with this id, if any. */
  behaviorOf(id: string): Behavior | undefined {
    return this.loaded.get(id);
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
    this.emitWriteHooks(event.connectorId, previous, write);
    if (write.kind !== "status" || write.scope === "local") return;
    if (
      write.scope === "full" &&
      !isAllowedConnectorStatusTransition(previous.status, write.status)
    ) {
      // Only a warning: scenarios and tests may force any transition.
      this.warn(
        `Connector ${event.connectorId} status ${previous.status} → ${write.status} is not an expected transition`,
      );
    }
    this.host.events.emit("connectorStatusChange", {
      connectorId: event.connectorId,
      status: write.status,
      previousStatus: previous.status,
    });
    if (write.scope === "full") {
      this.host.afterConnectorStatus(event.connectorId, write.status);
    }
  }

  /** Event hooks for a connector write that has been applied. */
  private emitWriteHooks(
    connectorId: number,
    previous: ConnectorRecord,
    write: ConnectorWrite,
  ): void {
    if (!this.hooked || write.kind === "restore") return;
    const now = this._state.connectors[connectorId];
    if (!now) return;
    if (write.kind === "status" && previous.status !== now.status) {
      this.emitHook("connectorStatus", {
        connectorId,
        from: previous.status,
        to: now.status,
      });
      return;
    }
    if (
      write.kind !== "transaction.set" &&
      write.kind !== "transaction.patch"
    ) {
      return;
    }
    const before = previous.transaction;
    const after = now.transaction;
    if ((!before || before.stopTime) && after && !after.stopTime) {
      // Built when the hook is delivered: a 2.x transaction gets its id after
      // the write that attaches it.
      this.emitHook("transactionStarted", () =>
        this.transactionEvent(
          connectorId,
          this._state.connectors[connectorId]?.transaction ?? after,
        ),
      );
    } else if (
      before &&
      before.stopTime === null &&
      (!after || after.stopTime)
    ) {
      this.emitHook(
        "transactionStopped",
        this.transactionEvent(connectorId, after ?? before),
      );
    }
  }

  private transactionEvent(
    connectorId: number,
    tx: NonNullable<ConnectorRecord["transaction"]>,
  ): TransactionEvent {
    // 2.x names its own reason (`stoppedReason`); `stopReason` is the 1.6 one
    // the record also carries, and not what the Ended event says.
    const reason = tx.stoppedReason ?? tx.stopReason;
    return {
      connectorId,
      transactionId: tx.cpTransactionId ?? tx.id,
      idTag: tx.tagId ?? null,
      ...(reason ? { reason: String(reason) } : {}),
    };
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
    this.touch();
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
        this.hooked = false;
        this.hookQueue.length = 0;
        for (const id of [...this.hookContexts.keys()]) this.endHookContext(id);
        for (const cancel of this.pendingMains.values()) cancel();
        this.pendingMains.clear();
        for (const scope of [...this.callScopes]) this.endScope(scope);
        for (const scope of this.mainScopes.values()) scope.cancel();
        this.mainScopes.clear();
        for (const scope of this.resumeScopes.values()) scope.cancel();
        this.resumeScopes.clear();
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

  // ---- event hooks --------------------------------------------------------

  /**
   * What the transport and the charge point report: the connection came up or
   * went down, the CSMS sent a CALL, the CSMS answered one of ours. Delivered
   * to the `on` table of every loaded behavior, in load order, after the turn
   * that caused it (see {@link deliverHooks}).
   */
  observe(event: EngineObservation): void {
    if (!this.hooked || this.disposed) return;
    switch (event.type) {
      case "connected":
        this.emitHook("connected", { at: this.host.clock.now() });
        break;
      case "disconnected":
        this.emitHook("disconnected", {
          at: this.host.clock.now(),
          ...(event.code === undefined ? {} : { code: event.code }),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        });
        break;
      case "callResult":
        this.emitHook("callResult", {
          action: event.action,
          messageId: event.messageId,
          outcome: event.outcome,
          payload: jsonCopy(event.payload),
        });
        break;
      case "callReceived":
        this.emitHook("callReceived", {
          action: event.action,
          messageId: event.messageId,
          payload: jsonCopy(event.payload),
        });
        break;
    }
  }

  /** A dormant behavior that no run holds: no rules, no `main`, no hooks. */
  private isIdle(id: string): boolean {
    return this.dormant.has(id) && !this.holders.has(id);
  }

  private refreshHooked(): void {
    const active = [...this.loaded.values()].filter((b) => !this.isIdle(b.id));
    this.hooked = active.some((b) => b.on !== undefined);
    this.intercepting = active.some((b) => b.beforeSend !== undefined);
  }

  // ---- send interception --------------------------------------------------

  /**
   * Run the `beforeSend` of every loaded behavior, in load order, over a
   * station-initiated CALL that is about to be queued. The transports call it
   * from their one send path; `ctx.raw` does not come here. Returns the
   * payload to send or `{ drop: true }`, in which case nothing may go on the
   * wire and the caller of the CALL must be told it was dropped.
   *
   * Synchronous by design: the behaviors are chained one after the other, so
   * their order cannot move. A function that throws, returns a promise or
   * returns something that is not an object is logged and skipped; the CALL
   * goes on with the payload as the previous step left it.
   */
  beforeSend(action: string, payload: unknown): BeforeSendResult {
    if (!this.intercepting || this.disposed) return { payload };
    const names = this.outboundNames(action, payload);
    let current = payload;
    for (const behavior of [...this.loaded.values()]) {
      const table = behavior.beforeSend;
      if (!table || this.isIdle(behavior.id)) continue;
      for (const name of names) {
        const fn = table[name];
        if (typeof fn !== "function") continue;
        const { ctx } = this.hookContext(behavior);
        let returned: unknown;
        this.interceptDepth++;
        try {
          returned = fn(jsonCopy(current) as Record<string, unknown>, ctx);
        } catch (error) {
          this.warn(
            `Behavior ${behavior.id}: beforeSend.${name} failed: ${describe(error)}; the ${action} goes out as it was`,
          );
          continue;
        } finally {
          this.interceptDepth--;
          this.touch();
        }
        if (returned === undefined) continue;
        if (isThenable(returned)) {
          this.warn(
            `Behavior ${behavior.id}: beforeSend.${name} returned a promise; it must be synchronous, so the ${action} goes out as it was`,
          );
          continue;
        }
        if (typeof returned !== "object" || returned === null) {
          this.warn(
            `Behavior ${behavior.id}: beforeSend.${name} returned neither a payload object nor { drop: true }; ignored`,
          );
          continue;
        }
        if ((returned as { drop?: unknown }).drop === true) {
          this.host.logger.info(
            `[behavior ${behavior.id}] beforeSend.${name} dropped a ${action}`,
            LogType.OCPP,
          );
          return { drop: true };
        }
        if (Array.isArray(returned)) {
          this.warn(
            `Behavior ${behavior.id}: beforeSend.${name} returned an array; ignored`,
          );
          continue;
        }
        current = returned;
      }
    }
    return { payload: current };
  }

  /** True while a `beforeSend` function runs (a `ctx.send` from it waits its turn). */
  get intercepts(): boolean {
    return this.interceptDepth > 0;
  }

  /**
   * The keys of a `beforeSend` table that name this CALL: its wire action,
   * and on 2.x the 1.6 spelling of a transaction message (`TransactionEvent`
   * `Started` is `StartTransaction`, `Ended` is `StopTransaction`). The
   * payload handed over is always the one of the station's own version.
   */
  private outboundNames(action: string, payload: unknown): string[] {
    const names = [action];
    if (
      action === "TransactionEvent" &&
      isOcpp2Version(this.host.ocppVersion)
    ) {
      const type = (payload as { eventType?: unknown } | null)?.eventType;
      if (type === "Started") names.push("StartTransaction");
      else if (type === "Ended") names.push("StopTransaction");
    }
    return names;
  }

  /**
   * Queue a hook event. Hooks never run inside the turn that caused the event:
   * the queue is drained in a microtask, FIFO, so a hook that writes state or
   * sends runs after the current event (and its wire traffic) is finished.
   * An event raised while a hook runs joins the queue and is delivered after
   * the running hook returns. The order depends on nothing but program order,
   * so a run on a `VirtualClock` repeats exactly.
   */
  private emitHook(name: keyof BehaviorEvents, event: unknown): void {
    if (!this.hooked || this.disposed) return;
    this.hookQueue.push({ name, event });
    if (this.hookScheduled || this.hookDraining) return;
    this.hookScheduled = true;
    void Promise.resolve().then(() => this.deliverHooks());
  }

  private deliverHooks(): void {
    this.hookScheduled = false;
    if (this.hookDraining) return;
    this.hookDraining = true;
    try {
      for (
        let next = this.hookQueue.shift();
        next;
        next = this.hookQueue.shift()
      ) {
        if (this.disposed) {
          this.hookQueue.length = 0;
          return;
        }
        this.deliverHook(
          next.name,
          typeof next.event === "function"
            ? (next.event as () => unknown)()
            : next.event,
        );
      }
    } finally {
      this.hookDraining = false;
    }
  }

  private deliverHook(name: keyof BehaviorEvents, event: unknown): void {
    for (const behavior of [...this.loaded.values()]) {
      if (this.isIdle(behavior.id)) continue;
      const hook = behavior.on?.[name] as
        ((event: unknown, ctx: BehaviorContext) => unknown) | undefined;
      if (typeof hook !== "function") continue;
      const { ctx } = this.hookContext(behavior);
      try {
        const returned = hook.call(behavior.on, event, ctx);
        if (isThenable(returned)) {
          // State written after the hook's last await settles with it.
          returned.then(
            () => this.touch(),
            (error: unknown) => {
              this.touch();
              if (error instanceof BehaviorStopped) return;
              this.warn(
                `Behavior ${behavior.id}: ${name} hook failed: ${describe(error)}`,
              );
            },
          );
        }
      } catch (error) {
        this.warn(
          `Behavior ${behavior.id}: ${name} hook failed: ${describe(error)}`,
        );
      }
      this.touch();
    }
  }

  private hookContext(behavior: Behavior): {
    scope: Scope;
    ctx: BehaviorContext;
  } {
    let entry = this.hookContexts.get(behavior.id);
    if (!entry) {
      const scope = new Scope(behavior.id, false);
      entry = { scope, ctx: this.makeContext(behavior.id, scope) };
      this.hookContexts.set(behavior.id, entry);
    }
    return entry;
  }

  private endHookContext(id: string): void {
    this.hookContexts.get(id)?.scope.cancel();
    this.hookContexts.delete(id);
  }

  // ---- code behaviors -----------------------------------------------------

  /** Throws if this station cannot run `behavior`. */
  assertLoadable(behavior: Behavior): void {
    const shape = behaviorShapeProblem(behavior, (action) =>
      this.hasDefaultFor(action),
    );
    if (shape) throw new Error(shape);
    const problem = behaviorFitProblem(behavior, {
      ocppVersion: this.host.ocppVersion,
    });
    if (problem) throw new Error(problem);
  }

  /**
   * Load a behavior: check its `requires`, register the rule of every
   * `onCall` entry, and start `main`. Throws on a duplicate id or a capability
   * this station cannot meet; nothing is registered then.
   */
  loadBehavior(behavior: Behavior, options: LoadBehaviorOptions = {}): void {
    this.assertLoadable(behavior);
    if (this.loaded.has(behavior.id)) {
      throw new Error(`Behavior ${behavior.id} is already loaded`);
    }
    if (options.params !== undefined) {
      // Refuse before anything is registered or started.
      mergeParams(behavior.id, behavior.params, [options.params]);
    }
    if (!options.dormant) {
      this.registerRules(behavior, { kind: "code", behaviorId: behavior.id });
    }
    // Only now that nothing can throw any more: a failed load leaves no entry.
    if (options.params !== undefined) {
      this.selectionParams.set(behavior.id, options.params);
    }
    this.loaded.set(behavior.id, behavior);
    if (options.dormant) this.dormant.add(behavior.id);
    this.refreshHooked();
    this.dispatch({ type: "behavior.loaded", behaviorId: behavior.id });
    const orphan = this.orphans[behavior.id];
    if (orphan) {
      delete this.orphans[behavior.id];
      this.adoptState(behavior.id, orphan);
    }
    if (behavior.main && !options.dormant) {
      const scope = new Scope(behavior.id, false);
      this.mainScopes.set(behavior.id, scope);
      this.mainRuns.set(
        behavior.id,
        this.runDetached(behavior.id, scope, (ctx) => behavior.main!(ctx)),
      );
    }
  }

  /** How long a running `main` gets to finish once a reload asked it to stop. */
  static readonly RELOAD_GRACE_MS = 5_000;

  /**
   * Replace a loaded behavior with a new version of the same id (a reload).
   * It is atomic: a version the station cannot take (`requires`, `beforeSend`
   * on SOAP, a rule that cannot be registered) throws, and the old one keeps
   * running untouched.
   *
   * Exchanges in flight finish on the old code; a CALL that arrives after this
   * returns, a hook event and a `beforeSend` use the new one. `ctx.state`
   * survives. A running `main` sees `ctx.stopping` and gets
   * {@link ChargerEngine.RELOAD_GRACE_MS} on the station's clock to return,
   * after which its waits are cut off; the new `main` starts when the old one
   * has returned or the grace time is over, whichever is first.
   */
  replaceBehavior(next: Behavior): void {
    const previous = this.loaded.get(next.id);
    if (!previous) {
      throw new Error(
        `No behavior with id "${next.id}" is loaded on this station`,
      );
    }
    this.assertLoadable(next);
    // The params in force must fit the new version's schema, or it is refused
    // and the old version keeps running.
    mergeParams(next.id, next.params, this.layersOf(next.id));
    const dormant = this.dormant.has(next.id);
    if (!dormant) {
      // Register the new rules in place of the old ones; the exchanges the old
      // rules hold open are left to finish (their closures keep the old code).
      const owned = (owner: RuleOwner): boolean =>
        owner.kind === "code" && owner.behaviorId === next.id;
      // The new rules take the place of the old ones in the ranking: a reload
      // must not make this behavior win or lose against another one.
      const ranks = this.host.behaviors.ranks(owned);
      this.host.behaviors.release(owned);
      try {
        this.registerRules(next, { kind: "code", behaviorId: next.id }, ranks);
      } catch (error) {
        this.host.behaviors.release(owned);
        this.registerRules(
          previous,
          { kind: "code", behaviorId: next.id },
          ranks,
        );
        throw error;
      }
    }
    this.loaded.set(next.id, next);
    this.refreshHooked();
    // The hooks of the old version wind down like its main.
    const oldHooks = this.hookContexts.get(next.id);
    this.hookContexts.delete(next.id);
    const oldMain = this.mainScopes.get(next.id);
    this.mainScopes.delete(next.id);
    const oldRun = this.mainRuns.get(next.id);
    this.mainRuns.delete(next.id);
    const oldResume = this.resumeScopes.get(next.id);
    this.resumeScopes.delete(next.id);
    this.pendingMains.get(next.id)?.();
    this.pendingMains.delete(next.id);

    let startedNew = false;
    const startNew = (): void => {
      if (startedNew) return;
      startedNew = true;
      if (this.isIdle(next.id) || !next.main || this.disposed) return;
      if (this.loaded.get(next.id) !== next) return;
      const scope = new Scope(next.id, false);
      this.mainScopes.set(next.id, scope);
      this.mainRuns.set(
        next.id,
        this.runDetached(next.id, scope, (ctx) => next.main!(ctx)),
      );
    };
    const winding = [oldMain, oldResume, oldHooks?.scope].filter(
      (scope): scope is Scope => scope !== undefined,
    );
    for (const scope of winding) scope.requestStop();
    if (winding.length === 0) {
      startNew();
    } else {
      const clock = this.host.clock;
      const endGrace = (): void => {
        clock.clearTimeout(timer);
        this.pendingMains.delete(next.id);
        for (const scope of winding) scope.cancel();
        startNew();
      };
      const timer = clock.setTimeout(endGrace, ChargerEngine.RELOAD_GRACE_MS);
      // Unload, dispose or another reload before the grace time is over: cut
      // the old work off now, and the new main (if not started) never starts.
      this.pendingMains.set(next.id, () => {
        clock.clearTimeout(timer);
        for (const scope of winding) scope.cancel();
        startedNew = true;
      });
      if (oldRun) void oldRun.then(startNew);
      else startNew();
    }
    this.dispatch({ type: "behavior.loaded", behaviorId: next.id });
  }

  /**
   * Put the rules of a behavior loaded `dormant` to work under `owner` (a
   * scenario run, schema 1.5 `useBehavior`). The rules end with the owner:
   * release them with `BehaviorRegistry.release`. A behavior that is not
   * dormant already serves its rules; selecting it again does nothing. Throws
   * if no behavior has that id.
   *
   * `params` (schema 1.6) are the run's layer over the station's selection and
   * the behavior's defaults; they are validated first, so a refusal arms
   * nothing, and they end with the owner like the rules. A built-in
   * `default.*` behavior always answers: selecting one only sets its params.
   */
  activateBehavior(id: string, owner: RuleOwner, params?: JsonObject): void {
    const builtin = this.defaultsById.get(id);
    const behavior = builtin ?? this.loaded.get(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const key = ruleOwnerKey(owner);
    // Selecting a behavior again under the same owner (a `useBehavior` node
    // in a loop) replaces its params and rules instead of stacking them.
    this.setParamLayer(id, behavior, owner, params);
    if (builtin || !this.dormant.has(id)) return;
    this.host.behaviors.release((held) => ruleOwnerKey(held) === key);
    this.registerRules(behavior, owner);
    const held = this.holders.get(id) ?? new Map<string, RuleOwner>();
    const first = held.size === 0;
    held.set(key, owner);
    this.holders.set(id, held);
    if (!first) return;
    // The first owner switches the whole behavior on: `main` starts, hooks
    // and `beforeSend` are delivered.
    this.refreshHooked();
    if (behavior.main && !this.mainScopes.has(id) && !this.disposed) {
      const scope = new Scope(id, false);
      this.mainScopes.set(id, scope);
      this.mainRuns.set(
        id,
        this.runDetached(id, scope, (ctx) => behavior.main!(ctx)),
      );
    }
  }

  /**
   * Schema 1.6 `useBehavior` with `mode: "disable"`: for as long as `owner`
   * lives, every CALL of the behavior's actions is answered with the version's
   * `accepted` answer (`ctx.accepted(action)`) and nothing follows. The rules
   * are scenario rules, so they outrank the behavior's own (call-precedence
   * step 3) and end with the run. Throws when no behavior has that id, when
   * the station has no `accepted` answer for any of its actions, or when the
   * station cannot take scenario rules.
   */
  disableBehavior(id: string, owner: RuleOwner): void {
    const behavior = this.defaultsById.get(id) ?? this.loaded.get(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const answers: Array<[string, Record<string, unknown>]> = [];
    for (const action of Object.keys(behavior.onCall ?? {})) {
      try {
        answers.push([
          action,
          cannedResponse(action, this.host.ocppVersion, "accepted"),
        ]);
      } catch {
        // Not an action of this station's version, or no plain acceptance.
      }
    }
    if (answers.length === 0) {
      throw new Error(
        `useBehavior disable: ${id} answers no CALL on ${this.host.ocppVersion} that has an Accepted answer, so there is nothing to disable`,
      );
    }
    const key = ruleOwnerKey(owner);
    this.host.behaviors.release((held) => ruleOwnerKey(held) === key);
    const unregister: Array<() => void> = [];
    try {
      for (const [action, response] of answers) {
        unregister.push(
          this.host.behaviors.register({
            owner,
            action,
            mode: "replace",
            take: (_call, exchange) => {
              this.warn(
                `${action}: answered Accepted without acting (${id} is disabled by the running scenario)`,
              );
              exchange.reply({ ...response });
            },
          } satisfies BehaviorRule),
        );
      }
    } catch (error) {
      for (const off of unregister) off();
      throw error;
    }
  }

  // ---- params -------------------------------------------------------------

  /** The behavior with this id, built-in or loaded. */
  private declaredBehavior(id: string): Behavior | undefined {
    return this.defaultsById.get(id) ?? this.loaded.get(id);
  }

  /** The params layers of `id` over its defaults, oldest first. */
  private layersOf(id: string): JsonObject[] {
    const layers: JsonObject[] = [];
    const selected = this.selectionParams.get(id);
    if (selected) layers.push(selected);
    for (const layer of this.paramLayers.get(id)?.values() ?? []) {
      layers.push(layer.params);
    }
    return layers;
  }

  /**
   * The params `ctx.params` hands out for `id` now: defaults, the station's
   * selection, then each running scenario's layer (the newest on top).
   * Throws when they do not fit the schema.
   */
  effectiveParams(id: string): JsonObject {
    const behavior = this.declaredBehavior(id);
    return mergeParams(id, behavior?.params, this.layersOf(id));
  }

  /**
   * Set (or, with `undefined`, clear) the params the station's selection gives
   * `id`. Validated with the layers already running; throws and changes
   * nothing on a mismatch. Applies to the contexts made from now on.
   */
  setSelectionParams(id: string, params: JsonObject | undefined): void {
    const behavior = this.declaredBehavior(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const layers: JsonObject[] = params ? [params] : [];
    for (const layer of this.paramLayers.get(id)?.values() ?? []) {
      layers.push(layer.params);
    }
    mergeParams(id, behavior.params, layers);
    if (params && Object.keys(params).length > 0) {
      this.selectionParams.set(id, params);
    } else {
      this.selectionParams.delete(id);
    }
  }

  /**
   * Change the params the station's selection gives a loaded code behavior,
   * in place: the running scenarios' layers and the CALLs it has open are
   * kept; its `main` and hook context restart with the new values (as in a
   * reload, see {@link ChargerEngine.replaceBehavior}). Throws and changes
   * nothing when the params do not fit the schema.
   */
  reselectBehaviorParams(id: string, params: JsonObject | undefined): void {
    const behavior = this.loaded.get(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const before = this.selectionParams.get(id);
    this.setSelectionParams(id, params);
    try {
      this.replaceBehavior(behavior);
    } catch (error) {
      if (before) this.selectionParams.set(id, before);
      else this.selectionParams.delete(id);
      throw error;
    }
  }

  /** The params the station's selection gave each behavior, a copy. */
  get selectedParams(): Record<string, JsonObject> {
    return Object.fromEntries(this.selectionParams);
  }

  private setParamLayer(
    id: string,
    behavior: Behavior,
    owner: RuleOwner,
    params: JsonObject | undefined,
  ): void {
    const key = ruleOwnerKey(owner);
    const held = this.paramLayers.get(id);
    const others = [...(held ?? [])]
      .filter(([otherKey]) => otherKey !== key)
      .map(([, layer]) => layer.params);
    const selected = this.selectionParams.get(id);
    mergeParams(id, behavior.params, [
      ...(selected ? [selected] : []),
      ...others,
      ...(params ? [params] : []),
    ]);
    if (!params || Object.keys(params).length === 0) {
      held?.delete(key);
      return;
    }
    const layers = held ?? new Map();
    layers.delete(key);
    layers.set(key, { owner, params });
    this.paramLayers.set(id, layers);
  }

  /**
   * The runs that selected dormant behaviors let go (the end of a run): a
   * dormant behavior no owner holds any more stops its `main` and its hooks.
   * Rules are released with `BehaviorRegistry.release`, which the caller does.
   */
  deactivateBehaviors(owned: (owner: RuleOwner) => boolean): void {
    for (const [id, layers] of [...this.paramLayers]) {
      for (const [key, layer] of [...layers]) {
        if (owned(layer.owner)) layers.delete(key);
      }
      if (layers.size === 0) this.paramLayers.delete(id);
    }
    for (const [id, held] of [...this.holders]) {
      for (const [key, owner] of [...held]) if (owned(owner)) held.delete(key);
      if (held.size > 0) continue;
      this.holders.delete(id);
      this.pendingMains.get(id)?.();
      this.pendingMains.delete(id);
      this.mainScopes.get(id)?.cancel();
      this.mainScopes.delete(id);
      this.mainRuns.delete(id);
      this.endHookContext(id);
    }
    this.refreshHooked();
  }

  private registerRules(
    behavior: Behavior,
    owner: RuleOwner,
    ranks?: ReadonlyMap<string, number>,
  ): void {
    const unregister: Array<() => void> = [];
    try {
      for (const [action, call] of Object.entries(behavior.onCall ?? {})) {
        const rank = ranks?.get(ruleKey(owner, action));
        unregister.push(
          this.host.behaviors.register(
            {
              owner,
              action,
              ...(call.match ? { match: call.match } : {}),
              mode: call.mode,
              ...(call.onBusy ? { onBusy: call.onBusy } : {}),
              take: (callInfo, exchange) =>
                this.runCall(behavior, call, callInfo, exchange),
            } satisfies BehaviorRule,
            rank === undefined ? undefined : { rank },
          ),
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
    this.holders.delete(id);
    this.selectionParams.delete(id);
    this.paramLayers.delete(id);
    this.refreshHooked();
    this.endHookContext(id);
    this.pendingMains.get(id)?.();
    this.pendingMains.delete(id);
    this.mainScopes.get(id)?.cancel();
    this.mainScopes.delete(id);
    this.resumeScopes.get(id)?.cancel();
    this.resumeScopes.delete(id);
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

  private resumeWaiting = false;

  /**
   * Run `onResume` once the CSMS has accepted the next BootNotification: the
   * boot gate refuses everything else until then, so a `ctx.send` from
   * `onResume` run any earlier would only be refused. Nothing is sent or
   * changed by waiting.
   */
  resumeAfterBoot(): void {
    this.resumeWaiting = true;
  }

  /** The station's boot was accepted: run the `onResume` that was waiting for it. */
  bootAccepted(): void {
    if (!this.resumeWaiting) return;
    this.resumeWaiting = false;
    this.resume();
  }

  /** Run `onResume` of every loaded behavior now; call it after state was restored. */
  resume(): void {
    for (const behavior of this.loaded.values()) {
      if (!behavior.onResume || this.dormant.has(behavior.id)) continue;
      this.resumeScopes.get(behavior.id)?.cancel();
      const scope = new Scope(behavior.id, false);
      this.resumeScopes.set(behavior.id, scope);
      this.runDetached(behavior.id, scope, (ctx) => behavior.onResume!(ctx));
    }
  }

  private runDetached(
    behaviorId: string,
    scope: Scope,
    run: (ctx: BehaviorContext) => Promise<void>,
  ): Promise<void> {
    const ctx = this.makeContext(behaviorId, scope);
    return Promise.resolve()
      .then(() => run(ctx))
      .catch((error: unknown) => {
        if (error instanceof BehaviorStopped) return;
        this.warn(`Behavior ${behaviorId} failed: ${describe(error)}`);
      })
      .finally(() => this.touch());
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
      this.touch();
      this.endScope(scope);
      const stopped = error instanceof BehaviorStopped;
      if (!stopped) {
        this.warn(
          `Behavior ${behavior.id} failed on ${info.action}: ${describe(error)}`,
        );
      }
      // A handler cut off while its CALL is still open (the behavior was
      // unloaded after a reload had let go of the rule that held the CALL)
      // answers InternalError, as an unload with the rule in place does.
      if (exchange.state === "open") {
        exchange.replyError(
          "InternalError",
          stopped
            ? `Behavior ${behavior.id} was stopped`
            : describe(error).slice(0, 255),
        );
      }
    };
    const finish = (outcome: CallOutcome): void => {
      this.touch();
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
    const effect = (settled?: string): void => {
      // The follow-up the default behaviors of ctx.defaultBehavior started
      // keeps the rules of the response queue (as before the engine). The
      // follow-up of the behavior itself needs its answer on the wire.
      for (const defaultEffect of env.defaultEffects) defaultEffect();
      if (afterUser && (settled === undefined || settled === "written")) {
        this.runAfter(behaviorId, scope, ctx, afterUser);
      } else {
        if (afterUser) {
          this.warn(
            `Behavior ${behaviorId}: the answer to ${info.action} was not delivered (${settled}); its follow-up is skipped`,
          );
        }
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
      if (exchange.state !== "open") {
        // The CALL was abandoned (the connection closed) while the handler
        // ran: nothing was suppressed, so nothing follows.
        dropped("the connection closed");
        return;
      }
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
      .finally(() => {
        this.touch();
        this.endScope(scope);
      });
    void ctx;
  }

  // ---- default behaviors --------------------------------------------------

  /** Register the behaviors that answer when no user behavior does. */
  registerDefault(behavior: Behavior): void {
    this.defaultsById.set(behavior.id, behavior);
    for (const [action, call] of Object.entries(behavior.onCall ?? {})) {
      this.defaults.set(action, { behavior, call });
    }
    this.dispatch({ type: "behavior.loaded", behaviorId: behavior.id });
  }

  /** Does a default behavior answer `action`? */
  hasDefault(action: string): boolean {
    return this.defaults.has(action);
  }

  /** Does a default behavior answer `action` or one of its spellings? */
  private hasDefaultFor(action: string): boolean {
    return csmsActionAliases(action).some((name) => this.defaults.has(name));
  }

  /**
   * Run the default behavior of `action` for a request that reached the
   * default path. Written for the handlers: the response, and the effect that
   * starts the follow-up once the response settled.
   */
  runDefault(action: string, payload: unknown): DefaultResult {
    const entry = this.defaults.get(action);
    if (!entry) throw new Error(`No default behavior answers ${action}`);
    // Not connection-bound while the answer is in the pipeline: a close before
    // the follow-up starts cancels nothing (the follow-up then runs, as the
    // old code ran it). See `CONNECTION_BOUND_DEFAULTS` for what binds it once
    // it runs.
    const scope = new Scope(entry.behavior.id, false);
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
    const effect = (): void => {
      scope.connectionBound = CONNECTION_BOUND_DEFAULTS.has(entry.behavior.id);
      this.runAfter(entry.behavior.id, scope, ctx, after);
    };
    // The response queue drops an effect on a close the station made, a stale
    // generation or a dispose: nothing would end this scope then.
    effect.onDropped = (): void => this.endScope(scope);
    return { response: outcome.response, effect };
  }

  // ---- the context --------------------------------------------------------

  private makeContext(
    behaviorId: string,
    scope: Scope,
    env?: CallEnv,
  ): BehaviorContext {
    const touch = (): void => this.touch();
    const warn = (message: string): void => this.warn(message);
    const readState = (): ChargerState => this._state;
    const runDefault = (action: string, req: unknown): DefaultResult =>
      this.runDefault(action, req);
    const host = this.host;
    const snapshotCharger = (): ChargerSnapshot => this.snapshotCharger();
    const clock = host.clock;
    const behavior = this.loaded.get(behaviorId);
    const requires = new Set(behavior?.requires ?? []);
    // Fixed for the life of the context: a CALL and its follow-up see the
    // params the CALL arrived with.
    const params = freezeParams(this.paramsForContext(behaviorId));
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
      this.snapshotConnector(id);
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
        if (this.interceptDepth > 0) await Promise.resolve();
        live();
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
        live();
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
          this.notifyStatus("firmware", status, opts?.requestId);
        },
        signedFirmwareStatus: (status, requestId) => {
          live();
          this.notifyStatus("signedFirmware", status, requestId);
        },
        logStatus: (status, opts) => {
          live();
          this.notifyStatus("log", status, opts?.requestId);
        },
        diagnosticsStatus: (status) => {
          live();
          this.notifyStatus("diagnostics", status);
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
      accepted: (action) =>
        cannedResponse(action, host.ocppVersion, "accepted"),
      rejected: (action) =>
        cannedResponse(action, host.ocppVersion, "rejected"),
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
  snapshotConnector(id: number): ConnectorSnapshot | undefined {
    const connector = this.host.getConnector(id);
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
  snapshotCharger(): ChargerSnapshot {
    return {
      id: this.host.id,
      ocppVersion: this.host.ocppVersion,
      status: String(this.host.status),
      connectorIds: [...this.host.connectors.keys()],
    };
  }

  /**
   * Send a station status notification (`ctx.notify`, the scenario `notify`
   * node, #654): FirmwareStatusNotification, SignedFirmwareStatusNotification,
   * LogStatusNotification or DiagnosticsStatusNotification.
   */
  notifyStatus(kind: NotifyKind, status: string, requestId?: number): void {
    this.dispatch({
      type: "notified",
      kind,
      status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  /** `effectiveParams`, but a context never fails to be made over a stale layer. */
  private paramsForContext(id: string): JsonObject {
    try {
      return this.effectiveParams(id);
    } catch (error) {
      this.warn(`${describe(error)}; running ${id} with its defaults`);
      return this.declaredBehavior(id)?.params?.defaults ?? EMPTY_PARAMS;
    }
  }

  private warn(message: string): void {
    this.host.logger.warn(message, LogType.OCPP);
  }
}
