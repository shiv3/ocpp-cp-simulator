// packages/k6-runtime/src/behaviorHost.ts
// The k6 host of the behavior API (docs/analyses/charger-engine.md, "Loading
// code"): implements `BehaviorContext` over the OCPP 1.6J charge point of this
// runtime, which is the same `ScenarioHost` the scenario interpreter drives.
//
// What a behavior gets on k6, and what it does not:
//   - `onCall` rules with mode "replace" answer the CSMS CALLs of their action;
//     everything else is answered by the auto-responder as before.
//   - `main` runs once per charge point, concurrently with the others.
//   - waits (`sleep`, `until`) are timers of this host, never k6 `sleep()`, so
//     one VU can drive many charge points and stopping rejects them all.
//   - Not supported, and refused at export: mode "extend" / `defaultBehavior`
//     (the k6 auto-responder has no follow-up effects to extend), the physical
//     verbs and `connector()` (there is no connector model), and the
//     capabilities `physical`, `virtual-time` and `ocpp2.x`.
//     The members still exist and throw a clear error, for code the static
//     check could not see (an aliased context).
//   - Responses are not checked against the OCPP schema (`skipValidation` has
//     nothing to skip).
import { deepPartialMatch } from "./assertions.ts";
import { seededStream } from "./behaviorRandom.ts";
import type {
  Behavior,
  BehaviorCapability,
  BehaviorContext,
  CallAnswer,
  CallOutcome,
  JsonValue,
} from "./behaviorTypes.ts";
import type { CallObserver, WireCall } from "./types.ts";

/** What the host needs from the charge point: a subset of OcppChargePoint. */
export interface BehaviorCp {
  readonly cpId: string;
  readonly connectorId: number;
  call(c: WireCall): Promise<Record<string, unknown>>;
  sendRaw(frame: string): void;
  setCallHandler(handler: CallHandler | null): void;
  /** Watch the wire for `beforeSend` and the call hooks; absent: none fire. */
  setObserver?(observer: CallObserver | null): void;
  getLocalStatus(): string;
}

/** How the host answers an inbound CALL it claims. */
export type CallAnswerToSend =
  | { kind: "result"; payload: Record<string, unknown> }
  | { kind: "error"; code: string; description: string }
  | { kind: "none" };

/** The charge point asks; the host returns null to leave the CALL to the
 *  auto-responder, or the answer it takes over. `sent` runs after the frame
 *  went out (or was skipped). */
export type CallHandler = (
  action: string,
  payload: Record<string, unknown>,
) => { answer: Promise<CallAnswerToSend>; sent: () => void } | null;

export interface Timers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export class BehaviorStopped extends Error {
  constructor() {
    super("behavior stopped");
    this.name = "BehaviorStopped";
  }
}

export class BehaviorTimeout extends Error {
  constructor(ms: number) {
    super(`behavior wait timed out after ${ms}ms`);
    this.name = "BehaviorTimeout";
  }
}

/** Capabilities this host can meet. */
export const K6_CAPABILITIES: readonly BehaviorCapability[] = [
  "ocpp1.6",
  "raw-frames",
];

/** `ctx` members this host cannot provide; the export refuses a behavior that
 *  names one, and the member throws at run time otherwise. */
export const UNSUPPORTED_CTX_MEMBERS: readonly string[] = [
  "defaultBehavior",
  "connector",
  "plugIn",
  "unplug",
  "authorize",
  "startCharging",
  "stopCharging",
  "setConnectorStatus",
];

/** Event hooks the k6 host delivers. */
export const SUPPORTED_HOOKS = [
  "connected",
  "disconnected",
  "callResult",
  "callReceived",
] as const;

/** Event hooks that need a connector or transaction model the host lacks. */
const UNSUPPORTED_HOOKS = [
  "connectorStatus",
  "transactionStarted",
  "transactionStopped",
] as const;

/** What the host cannot meet: `requires` it lacks, `extend` rules and hooks it cannot feed. */
export function unmetBy(behavior: Behavior): string[] {
  const problems: string[] = [];
  for (const need of behavior.requires ?? []) {
    if (!K6_CAPABILITIES.includes(need)) {
      problems.push(
        `behavior "${behavior.id}" requires "${need}", which the k6 host cannot meet` +
          ` (it provides: ${K6_CAPABILITIES.join(", ")})`,
      );
    }
  }
  for (const hook of UNSUPPORTED_HOOKS) {
    if (behavior.on?.[hook] !== undefined) {
      problems.push(
        `behavior "${behavior.id}" on.${hook} is not supported by the k6 host` +
          ` (it has no connector or transaction model); the hooks it has are` +
          ` ${SUPPORTED_HOOKS.join(", ")}`,
      );
    }
  }
  const rules = behavior.onCall ?? {};
  for (const action of Object.keys(rules)) {
    if (rules[action].mode !== "replace") {
      problems.push(
        `behavior "${behavior.id}" onCall.${action} has mode "extend", which the k6 host does not support` +
          ` (the k6 auto-responder has no default behavior to extend); use "replace"`,
      );
    }
  }
  return problems;
}

export interface BehaviorHostOptions {
  cp: BehaviorCp;
  behaviors: readonly Behavior[];
  timers: Timers;
  /** The seed of the random streams. */
  seed: string;
  /**
   * The canned answers of `ctx.accepted` / `ctx.rejected`, per action, written
   * by the export from the bundled 1.6 response schemas. A missing entry means
   * the action has no such answer.
   */
  canned?: CannedResponses;
  log?: (message: string) => void;
}

/** `ctx.accepted` / `ctx.rejected` answers of the 1.6 actions that have one. */
export type CannedResponses = Readonly<
  Record<
    string,
    {
      readonly accepted?: Record<string, unknown>;
      readonly rejected?: Record<string, unknown>;
    }
  >
>;

interface Rule {
  behavior: Behavior;
  action: string;
  match?: Record<string, unknown>;
  busy: boolean;
  onBusy?: CallAnswer;
  /** The `onCall` entry as written: `handle` is called on it, as the simulator does. */
  spec: {
    handle(
      req: unknown,
      ctx: BehaviorContext,
    ): CallOutcome | Promise<CallOutcome>;
  };
}

export class BehaviorHost {
  private readonly cp: BehaviorCp;
  private readonly timers: Timers;
  private readonly seed: string;
  private readonly log: (message: string) => void;
  private readonly rules: Rule[] = [];
  private readonly mains: Array<{ id: string; done: Promise<void> }> = [];
  private readonly states = new Map<string, Record<string, JsonValue>>();
  private readonly contexts = new Map<string, BehaviorContext>();
  private readonly waits = new Map<number, () => void>();
  /** Rejects the `ctx.send` calls still waiting for an answer (see `stop`). */
  private readonly pendingSends = new Set<() => void>();
  private isStopping = false;
  private readonly hookQueue: Array<{ name: string; event: unknown }> = [];
  private hookScheduled = false;
  private hookDraining = false;
  private interceptDepth = 0;
  private readonly hooked: boolean;
  private readonly intercepting: boolean;

  constructor(private readonly opts: BehaviorHostOptions) {
    this.cp = opts.cp;
    this.timers = opts.timers;
    this.seed = opts.seed;
    this.log = opts.log ?? ((): void => undefined);
    this.hooked = opts.behaviors.some((b) => b.on !== undefined);
    this.intercepting = opts.behaviors.some((b) => b.beforeSend !== undefined);
    const ids = new Set<string>();
    for (const behavior of opts.behaviors) {
      if (ids.has(behavior.id)) {
        throw new Error(`behavior id "${behavior.id}" is given twice`);
      }
      ids.add(behavior.id);
      const problems = unmetBy(behavior);
      if (problems.length > 0) throw new Error(problems.join("\n"));
      for (const action of Object.keys(behavior.onCall ?? {})) {
        const rule = (behavior.onCall ?? {})[action];
        this.rules.push({
          behavior,
          action,
          match: rule.match,
          busy: false,
          onBusy: rule.onBusy,
          spec: rule,
        });
      }
    }
  }

  get stopping(): boolean {
    return this.isStopping;
  }

  /**
   * What went wrong during the run, for the iteration to report: a `main` that
   * threw, and a connection the CSMS closed before the host was stopped.
   */
  readonly problems: string[] = [];
  private closedWaiters: Array<() => void> = [];
  private attached = false;

  /**
   * Resolves when the connection closes while the host is still running (it
   * never resolves otherwise). The iteration ends then, with a problem.
   */
  whenClosed(): Promise<void> {
    return new Promise<void>((resolve) => this.closedWaiters.push(resolve));
  }

  /**
   * Claim the CALLs of the rules and watch the wire. Call it before the
   * socket opens, so the BootNotification passes `beforeSend` and its answer
   * reaches `callResult`; {@link start} does it when it was not done.
   */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.cp.setCallHandler((action, payload) => this.claim(action, payload));
    this.cp.setObserver?.({
      beforeSend: (action, payload) =>
        this.intercepting ? this.runBeforeSend(action, payload) : { payload },
      callResult: (event) => this.emitHook("callResult", event),
      callReceived: (event) => this.emitHook("callReceived", event),
      disconnected: (event) => {
        if (!this.isStopping) {
          this.problems.push(
            `${this.cp.cpId}: the connection was closed before the iteration ended` +
              (event.code === undefined ? "" : ` (code ${event.code})`),
          );
          for (const resolve of this.closedWaiters.splice(0)) resolve();
        }
        this.emitHook("disconnected", { at: Date.now(), ...event });
      },
    });
  }

  /** The socket is up and booted: tell the hooks, and start every `main`. */
  start(): void {
    this.attach();
    this.emitHook("connected", { at: Date.now() });
    for (const behavior of this.opts.behaviors) {
      const main = behavior.main;
      if (main === undefined) continue;
      const ctx = this.contextOf(behavior);
      const done = Promise.resolve()
        .then(() => main.call(behavior, ctx))
        .then(
          () => undefined,
          (err: unknown) => {
            if (!(err instanceof BehaviorStopped)) {
              this.log(
                `behavior ${behavior.id}: main failed: ${describe(err)}`,
              );
              this.problems.push(
                `${this.cp.cpId}: main of "${behavior.id}" failed: ${describe(err)}`,
              );
            }
          },
        );
      this.mains.push({ id: behavior.id, done });
    }
  }

  get hasMain(): boolean {
    return this.mains.length > 0;
  }

  /** Resolves when every `main` returned (or failed). */
  mainsDone(): Promise<void> {
    return Promise.all(this.mains.map((m) => m.done)).then(() => undefined);
  }

  /**
   * Stop: `stopping` turns true, every pending wait rejects with
   * BehaviorStopped and no new CALL is claimed. Resolves when the mains
   * settled, or after `graceMs` (a main that waits on something that is not
   * ours cannot hang the iteration). Returns the ids of mains still running.
   */
  async stop(graceMs: number): Promise<string[]> {
    this.isStopping = true;
    this.cp.setCallHandler(null);
    this.cp.setObserver?.(null);
    this.hookQueue.length = 0;
    for (const cancel of [...this.waits.values()]) cancel();
    this.waits.clear();
    // A `ctx.send` waiting on a slow CSMS must not keep its `main` alive past
    // the grace time: the wait is cut like every other wait.
    for (const cancel of [...this.pendingSends]) cancel();
    this.pendingSends.clear();
    const pending = new Set(this.mains.map((m) => m.id));
    const settled = Promise.all(
      this.mains.map((m) =>
        m.done.then(() => {
          pending.delete(m.id);
        }),
      ),
    );
    let timeoutId = -1;
    const grace = new Promise<void>((resolve) => {
      timeoutId = this.timers.setTimeout(resolve, graceMs);
    });
    await Promise.race([settled, grace]);
    this.timers.clearTimeout(timeoutId);
    return [...pending];
  }

  // ---- event hooks and beforeSend ----------------------------------------

  /**
   * Queue a hook event. As in the simulator, hooks never run inside the turn
   * that caused the event: the queue is drained in a microtask, FIFO, and an
   * event raised by a hook waits until that hook returned.
   */
  private emitHook(name: string, event: unknown): void {
    if (!this.hooked || this.isStopping) return;
    this.hookQueue.push({ name, event: jsonCopy(event) });
    if (this.hookScheduled || this.hookDraining) return;
    this.hookScheduled = true;
    void Promise.resolve().then(() => this.drainHooks());
  }

  private drainHooks(): void {
    this.hookScheduled = false;
    if (this.hookDraining) return;
    this.hookDraining = true;
    try {
      for (
        let next = this.hookQueue.shift();
        next !== undefined;
        next = this.hookQueue.shift()
      ) {
        if (this.isStopping) {
          this.hookQueue.length = 0;
          return;
        }
        this.deliverHook(next.name, next.event);
      }
    } finally {
      this.hookDraining = false;
    }
  }

  private deliverHook(name: string, event: unknown): void {
    for (const behavior of this.opts.behaviors) {
      const table = behavior.on as
        | Record<
            string,
            ((e: unknown, c: BehaviorContext) => unknown) | undefined
          >
        | undefined;
      const hook = table?.[name];
      if (typeof hook !== "function") continue;
      try {
        const returned = hook.call(table, event, this.contextOf(behavior));
        if (isPromiseLike(returned)) {
          returned.then(undefined, (err: unknown) => {
            if (!(err instanceof BehaviorStopped)) {
              this.log(
                `behavior ${behavior.id}: ${name} hook failed: ${describe(err)}`,
              );
            }
          });
        }
      } catch (err) {
        this.log(
          `behavior ${behavior.id}: ${name} hook failed: ${describe(err)}`,
        );
      }
    }
  }

  /**
   * The `beforeSend` chain over a CALL about to be queued, in the order the
   * behaviors were given. A function that throws, returns a promise or returns
   * something that is not an object is logged and skipped.
   */
  private runBeforeSend(
    action: string,
    payload: Record<string, unknown>,
  ): { drop: true } | { payload: Record<string, unknown> } {
    let current = payload;
    for (const behavior of this.opts.behaviors) {
      const fn = behavior.beforeSend?.[action];
      if (typeof fn !== "function") continue;
      let returned: unknown;
      this.interceptDepth++;
      try {
        returned = fn(
          jsonCopy(current) as Record<string, unknown>,
          this.contextOf(behavior),
        );
      } catch (err) {
        this.log(
          `behavior ${behavior.id}: beforeSend.${action} failed: ${describe(err)}; the CALL goes out as it was`,
        );
        continue;
      } finally {
        this.interceptDepth--;
      }
      if (returned === undefined) continue;
      if (isPromiseLike(returned)) {
        this.log(
          `behavior ${behavior.id}: beforeSend.${action} returned a promise; it must be synchronous, so the CALL goes out as it was`,
        );
        continue;
      }
      if (typeof returned !== "object" || returned === null) {
        this.log(
          `behavior ${behavior.id}: beforeSend.${action} returned neither a payload object nor { drop: true }; ignored`,
        );
        continue;
      }
      if ((returned as { drop?: unknown }).drop === true) {
        this.log(`behavior ${behavior.id}: beforeSend.${action} dropped it`);
        return { drop: true };
      }
      if (Array.isArray(returned)) continue;
      current = returned as Record<string, unknown>;
    }
    return { payload: current };
  }

  // ---- inbound CALLs ------------------------------------------------------

  private claim(
    action: string,
    payload: Record<string, unknown>,
  ): ReturnType<CallHandler> {
    if (this.isStopping) return null;
    const rule = this.rules.find(
      (r) =>
        r.action === action &&
        (r.match === undefined || deepPartialMatch(r.match, payload)),
    );
    if (rule === undefined) return null;
    if (rule.busy) {
      return {
        answer: Promise.resolve(
          answerOf(
            rule.onBusy ?? {
              error: {
                code: "GenericError",
                description: `${rule.behavior.id} is busy with ${action}`,
              },
            },
          ),
        ),
        sent: () => undefined,
      };
    }
    rule.busy = true;
    let after: (() => Promise<void>) | undefined;
    const failed = (err: unknown): CallAnswerToSend => {
      this.log(
        `behavior ${rule.behavior.id}: ${action} failed: ${describe(err)}`,
      );
      return {
        kind: "error",
        code: "InternalError",
        description: `behavior ${rule.behavior.id} failed`,
      };
    };
    const answer = Promise.resolve()
      .then(() => rule.spec.handle(payload, this.contextOf(rule.behavior)))
      .then((outcome): CallAnswerToSend => {
        // A handler that returned nothing (or something that is no outcome) is
        // the handler's failure, answered like a throw, not left unanswered.
        try {
          after = outcome.after;
          return answerOf(outcome);
        } catch (err) {
          return failed(err);
        }
      }, failed)
      .finally(() => {
        rule.busy = false;
      });
    return {
      answer,
      sent: () => {
        if (after === undefined) return;
        const run = after;
        after = undefined;
        Promise.resolve()
          .then(run)
          .catch((err: unknown) => {
            if (!(err instanceof BehaviorStopped)) {
              this.log(
                `behavior ${rule.behavior.id}: ${action} follow-up failed: ${describe(err)}`,
              );
            }
          });
      },
    };
  }

  // ---- the context --------------------------------------------------------

  private contextOf(behavior: Behavior): BehaviorContext {
    let ctx = this.contexts.get(behavior.id);
    if (ctx === undefined) {
      ctx = this.buildContext(behavior);
      this.contexts.set(behavior.id, ctx);
    }
    return ctx;
  }

  private wait(ms: number, onFire: () => void, onCancel: () => void): void {
    const id = this.timers.setTimeout(() => {
      this.waits.delete(id);
      onFire();
    }, ms);
    this.waits.set(id, () => {
      this.timers.clearTimeout(id);
      onCancel();
    });
  }

  private notifyCall(action: string, payload: Record<string, unknown>): void {
    this.cp.call({ action, payload }).catch((err: unknown) => {
      this.log(`${action} failed: ${describe(err)}`);
    });
  }

  // `host` is `this`: the context is an object literal whose getters and
  // methods need the host, not their own `this`.
  private buildContext(
    behavior: Behavior,
    host: BehaviorHost = this,
  ): BehaviorContext {
    const cp = host.cp;
    const unsupported = (member: string): never => {
      throw new Error(
        `ctx.${member} is not supported by the k6 host (behavior "${behavior.id}")`,
      );
    };
    const canned = (
      action: string,
      kind: "accepted" | "rejected",
    ): Record<string, unknown> => {
      const answer = host.opts.canned?.[action]?.[kind];
      if (answer === undefined) {
        throw new Error(
          `ctx.${kind}("${action}"): the ${action} response on OCPP-1.6J has no ${kind === "accepted" ? "Accepted" : "Rejected"} answer; build the response by hand`,
        );
      }
      return { ...answer };
    };
    let state = this.states.get(behavior.id);
    if (state === undefined) {
      state = {};
      this.states.set(behavior.id, state);
    }
    const userState = state;
    const streams = new Map<string, ReturnType<typeof seededStream>>();
    return {
      now: () => Date.now(),
      sleep(ms: number): Promise<void> {
        if (host.isStopping) return Promise.reject(new BehaviorStopped());
        return new Promise<void>((resolve, reject) => {
          host.wait(ms, resolve, () => reject(new BehaviorStopped()));
        });
      },
      until<T>(promise: Promise<T>, opts: { ms: number }): Promise<T> {
        if (host.isStopping) return Promise.reject(new BehaviorStopped());
        return new Promise<T>((resolve, reject) => {
          let settled = false;
          let id = -1;
          const done = (): void => {
            settled = true;
            host.timers.clearTimeout(id);
            host.waits.delete(id);
          };
          id = host.timers.setTimeout(() => {
            if (settled) return;
            done();
            reject(new BehaviorTimeout(opts.ms));
          }, opts.ms);
          host.waits.set(id, () => {
            if (settled) return;
            done();
            reject(new BehaviorStopped());
          });
          promise.then(
            (value) => {
              if (settled) return;
              done();
              resolve(value);
            },
            (err: unknown) => {
              if (settled) return;
              done();
              reject(err);
            },
          );
        });
      },
      random: (stream: string) => {
        // One stream per name for the life of the context: a second call
        // continues it, as on the simulator.
        let one = streams.get(stream);
        if (one === undefined) {
          one = seededStream(host.seed, cp.cpId, `${behavior.id}/${stream}`);
          streams.set(stream, one);
        }
        return one;
      },
      get stopping(): boolean {
        return host.isStopping;
      },
      get state(): Record<string, JsonValue> {
        return userState;
      },
      set state(value: Record<string, JsonValue>) {
        for (const key of Object.keys(userState)) delete userState[key];
        Object.assign(userState, value);
      },
      async send(action, payload, opts) {
        if (host.isStopping) throw new BehaviorStopped();
        // From inside a beforeSend the CALL waits for its turn, so it goes out
        // after the CALL being intercepted.
        if (host.interceptDepth > 0) await Promise.resolve();
        const request = cp.call({
          action,
          payload: payload as Record<string, unknown>,
        });
        if (opts?.fireAndForget) {
          request.catch((err: unknown) =>
            host.log(`${action} failed: ${describe(err)}`),
          );
          return undefined;
        }
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const cancel = (): void => reject(new BehaviorStopped());
          host.pendingSends.add(cancel);
          request.then(
            (value) => {
              host.pendingSends.delete(cancel);
              resolve(value);
            },
            (err: unknown) => {
              host.pendingSends.delete(cancel);
              reject(err);
            },
          );
        });
      },
      raw(frame: string): void {
        if (!(behavior.requires ?? []).includes("raw-frames")) {
          throw new Error(
            `Behavior ${behavior.id} uses ctx.raw but does not list "raw-frames" in requires`,
          );
        }
        if (host.isStopping) throw new BehaviorStopped();
        try {
          cp.sendRaw(frame);
        } catch (err) {
          // As on the simulator, a frame that cannot go out is a warning, not
          // an exception in the behavior.
          host.log(
            `behavior ${behavior.id}: raw frame failed: ${describe(err)}`,
          );
        }
      },
      plugIn: () => unsupported("plugIn"),
      unplug: () => unsupported("unplug"),
      authorize: () => unsupported("authorize"),
      startCharging: () => unsupported("startCharging"),
      stopCharging: () => unsupported("stopCharging"),
      setConnectorStatus: () => unsupported("setConnectorStatus"),
      notify: {
        // 1.6 FirmwareStatusNotification has no requestId (the core host
        // drops it too); the Whitepaper variants carry it.
        firmwareStatus: (status) =>
          host.notifyCall("FirmwareStatusNotification", { status }),
        signedFirmwareStatus: (status, requestId) =>
          host.notifyCall("SignedFirmwareStatusNotification", {
            status,
            requestId,
          }),
        logStatus: (status, opts) =>
          host.notifyCall("LogStatusNotification", {
            status,
            ...(opts?.requestId === undefined
              ? {}
              : { requestId: opts.requestId }),
          }),
        diagnosticsStatus: (status) =>
          host.notifyCall("DiagnosticsStatusNotification", { status }),
      },
      defaultBehavior: () => unsupported("defaultBehavior"),
      accepted: (action) => canned(action, "accepted"),
      rejected: (action) => canned(action, "rejected"),
      connector: () => unsupported("connector"),
      get charger() {
        return {
          id: cp.cpId,
          ocppVersion: "OCPP-1.6J",
          status: cp.getLocalStatus(),
          connectorIds: [cp.connectorId],
        };
      },
      log: (message: string) => host.log(`[${behavior.id}] ${message}`),
    };
  }
}

function answerOf(outcome: CallOutcome | CallAnswer): CallAnswerToSend {
  if ("error" in outcome) {
    return {
      kind: "error",
      code: outcome.error.code,
      description: outcome.error.description,
    };
  }
  if ("noResponse" in outcome) return { kind: "none" };
  const payload = outcome.response;
  return {
    kind: "result",
    payload:
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
  };
}

function jsonCopy(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
