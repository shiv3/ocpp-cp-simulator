import type {
  Behavior,
  BehaviorEvents,
  BehaviorParamsProjection,
  BehaviorContext,
  CallBehavior,
  ChargerSnapshot,
  ConnectorSnapshot,
  JsonObject,
  JsonValue,
  TransactionEvent,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import type {
  ConnectorRecord,
  ConnectorWrite,
} from "../../domain/connector/ConnectorRecord";
import { isAllowedConnectorStatusTransition } from "../../domain/connector/ConnectorTransitions";
import { isOcpp2Version } from "../../domain/types/OcppVersion";
import { RESERVED_PREFIX } from "./behaviorFit";
import { LogType } from "../../shared/Logger";
import type { SimClock } from "../../shared/clock";
import { csmsActionAliases } from "../../domain/types/csmsActionNames";
import type { RuleOwner } from "../behavior/BehaviorRegistry";
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
import { EMPTY_PARAMS } from "../behavior/paramsSchema";
import {
  BehaviorStopped,
  BehaviorTimeout,
  Scope,
  describe,
  isThenable,
  jsonCopy,
  type CallEnv,
} from "./scope";
import { BehaviorLifecycle } from "./behaviorLifecycle";
import { CallRunner } from "./callRunner";
import {
  makeBehaviorContext,
  snapshotChargerOf,
  snapshotConnectorOf,
} from "./behaviorContext";

export { BehaviorStopped, BehaviorTimeout };

/** Ids with this prefix belong to the built-in behaviors; none can be loaded. */

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
    this.lifecycle = new BehaviorLifecycle({
      host: this.host,
      loaded: this.loaded,
      dormant: this.dormant,
      holders: this.holders,
      mainScopes: this.mainScopes,
      resumeScopes: this.resumeScopes,
      mainRuns: this.mainRuns,
      pendingMains: this.pendingMains,
      callScopes: this.callScopes,
      defaultsById: this.defaultsById,
      selectionParams: this.selectionParams,
      paramLayers: this.paramLayers,
      hookContexts: this.hookContexts,
      orphans: () => this.orphans,
      disposed: () => this.disposed,
      dispatch: (event) => this.dispatch(event),
      warn: (message) => this.warn(message),
      hasDefaultFor: (action) => this.hasDefaultFor(action),
      isIdle: (id) => this.isIdle(id),
      refreshHooked: () => this.refreshHooked(),
      adoptState: (id, data) => this.adoptState(id, data),
      endScope: (scope) => this.endScope(scope),
      endHookContext: (id) => this.endHookContext(id),
      runDetached: (id, scope, run) => this.runDetached(id, scope, run),
      runCall: (behavior, call, callInfo, exchange) =>
        this.calls.runCall(behavior, call, callInfo, exchange),
    });
    this.calls = new CallRunner({
      host: this.host,
      callScopes: this.callScopes,
      defaults: this.defaults,
      touch: () => this.touch(),
      warn: (message) => this.warn(message),
      endScope: (scope) => this.endScope(scope),
      makeContext: (id, scope, env) => this.makeContext(id, scope, env),
    });
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
    // OCPP 1.6 §4.9: a change the transition table does not list. By default
    // only a warning: scenarios and tests may force any transition. Under
    // `statusTransitions: "enforce"` (#618, 1.6J) the connector still changes
    // (the simulated hardware did) but the StatusNotification stays off the
    // wire, so the CSMS under test only ever sees a conformant peer, unless
    // the write asked for it explicitly (`allowInvalidTransition`).
    let suppress = false;
    if (
      write.scope === "full" &&
      !isAllowedConnectorStatusTransition(previous.status, write.status)
    ) {
      suppress =
        this.host.enforcesStatusTransitions && !write.allowInvalidTransition;
      this.warn(
        suppress
          ? `Connector ${event.connectorId} status ${previous.status} → ${write.status} is not an OCPP 1.6 §4.9 transition; StatusNotification not sent (statusTransitions: enforce)`
          : `Connector ${event.connectorId} status ${previous.status} → ${write.status} is not an expected transition`,
      );
    }
    this.host.events.emit("connectorStatusChange", {
      connectorId: event.connectorId,
      status: write.status,
      previousStatus: previous.status,
    });
    if (suppress) {
      this.host.events.emit("statusNotificationSuppressed", {
        connectorId: event.connectorId,
        from: previous.status,
        to: write.status,
        reason: "invalidTransition",
      });
    }
    if (write.scope === "full") {
      this.host.afterConnectorStatus(
        event.connectorId,
        write.status,
        !suppress,
      );
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

  // ---- code behaviors (see behaviorLifecycle.ts) --------------------------

  private readonly lifecycle: BehaviorLifecycle;
  private readonly calls: CallRunner;

  /** Throws if this station cannot run `behavior`. */
  assertLoadable(behavior: Behavior): void {
    this.lifecycle.assertLoadable(behavior);
  }

  /**
   * Load a behavior: check its `requires`, register the rule of every
   * `onCall` entry, and start `main`. Throws on a duplicate id or a capability
   * this station cannot meet; nothing is registered then.
   */
  loadBehavior(behavior: Behavior, options: LoadBehaviorOptions = {}): void {
    this.lifecycle.loadBehavior(behavior, options);
  }

  /** How long a running `main` gets to finish once a reload asked it to stop. */
  static readonly RELOAD_GRACE_MS = BehaviorLifecycle.RELOAD_GRACE_MS;

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
    this.lifecycle.replaceBehavior(next);
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
    this.lifecycle.activateBehavior(id, owner, params);
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
    this.lifecycle.disableBehavior(id, owner);
  }

  /** The params `ctx.params` hands out for `id` now (see the lifecycle). */
  effectiveParams(id: string): JsonObject {
    return this.lifecycle.effectiveParams(id);
  }

  /**
   * Set (or, with `undefined`, clear) the params the station's selection gives
   * `id`. Validated with the layers already running; throws and changes
   * nothing on a mismatch. Applies to the contexts made from now on.
   */
  setSelectionParams(id: string, params: JsonObject | undefined): void {
    this.lifecycle.setSelectionParams(id, params);
  }

  /**
   * Change the params the station's selection gives a loaded code behavior,
   * in place: the running scenarios' layers and the CALLs it has open are
   * kept; its `main` and hook context restart with the new values (as in a
   * reload, see {@link ChargerEngine.replaceBehavior}). Throws and changes
   * nothing when the params do not fit the schema.
   */
  reselectBehaviorParams(id: string, params: JsonObject | undefined): void {
    this.lifecycle.reselectBehaviorParams(id, params);
  }

  /** Resolved behavior params, read-only (#654). */
  behaviorParamsProjection(): BehaviorParamsProjection {
    return this.lifecycle.projectParams();
  }

  /** The params the station's selection gave each behavior, a copy. */
  get selectedParams(): Record<string, JsonObject> {
    return this.lifecycle.selectedParams;
  }

  /**
   * The runs that selected dormant behaviors let go (the end of a run): a
   * dormant behavior no owner holds any more stops its `main` and its hooks.
   * Rules are released with `BehaviorRegistry.release`, which the caller does.
   */
  deactivateBehaviors(owned: (owner: RuleOwner) => boolean): void {
    this.lifecycle.deactivateBehaviors(owned);
  }

  /** Unload a behavior: stop its waits, release its rules, settle its open CALLs. */
  unloadBehavior(id: string): boolean {
    return this.lifecycle.unloadBehavior(id);
  }

  /**
   * Run `onResume` once the CSMS has accepted the next BootNotification: the
   * boot gate refuses everything else until then, so a `ctx.send` from
   * `onResume` run any earlier would only be refused. Nothing is sent or
   * changed by waiting.
   */
  resumeAfterBoot(): void {
    this.lifecycle.resumeAfterBoot();
  }

  /** The station's boot was accepted: run the `onResume` that was waiting for it. */
  bootAccepted(): void {
    this.lifecycle.bootAccepted();
  }

  /** Run `onResume` of every loaded behavior now; call it after state was restored. */
  resume(): void {
    this.lifecycle.resume();
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
    return this.calls.runDefault(action, payload);
  }

  // ---- the context --------------------------------------------------------

  private makeContext(
    behaviorId: string,
    scope: Scope,
    env?: CallEnv,
  ): BehaviorContext {
    return makeBehaviorContext(
      {
        host: this.host,
        touch: () => this.touch(),
        warn: (message) => this.warn(message),
        readState: () => this._state,
        runDefault: (action, req) => this.runDefault(action, req),
        snapshotCharger: () => this.snapshotCharger(),
        snapshotConnector: (id) => this.snapshotConnector(id),
        loadedBehavior: (id) => this.loaded.get(id),
        paramsForContext: (id) => this.paramsForContext(id),
        interceptDepth: () => this.interceptDepth,
        notifyStatus: (kind, status, requestId) =>
          this.notifyStatus(kind, status, requestId),
      },
      behaviorId,
      scope,
      env,
    );
  }

  /**
   * A read-only view of one connector: what `ctx.connector(id)` returns, and
   * what the scenario `$from` root `connector` reads (#654).
   */
  snapshotConnector(id: number): ConnectorSnapshot | undefined {
    return snapshotConnectorOf(this.host, id);
  }

  /** A read-only view of the station: `ctx.charger`, and the `$from` root `charger`. */
  snapshotCharger(): ChargerSnapshot {
    return snapshotChargerOf(this.host);
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
      return (
        this.lifecycle.declaredBehavior(id)?.params?.defaults ?? EMPTY_PARAMS
      );
    }
  }

  private warn(message: string): void {
    this.host.logger.warn(message, LogType.OCPP);
  }
}
