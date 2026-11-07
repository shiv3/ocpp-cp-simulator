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
import type { WireCall } from "./types.ts";

/** What the host needs from the charge point: a subset of OcppChargePoint. */
export interface BehaviorCp {
  readonly cpId: string;
  readonly connectorId: number;
  call(c: WireCall): Promise<Record<string, unknown>>;
  sendRaw(frame: string): void;
  setCallHandler(handler: CallHandler | null): void;
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

/** What the host cannot meet: `requires` it lacks and `extend` rules. */
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
  handle(
    req: unknown,
    ctx: BehaviorContext,
  ): CallOutcome | Promise<CallOutcome>;
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
  private isStopping = false;

  constructor(private readonly opts: BehaviorHostOptions) {
    this.cp = opts.cp;
    this.timers = opts.timers;
    this.seed = opts.seed;
    this.log = opts.log ?? ((): void => undefined);
    for (const behavior of opts.behaviors) {
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
          handle: rule.handle,
        });
      }
    }
  }

  get stopping(): boolean {
    return this.isStopping;
  }

  /** Claim the CALLs of the rules and start every `main`. */
  start(): void {
    this.cp.setCallHandler((action, payload) => this.claim(action, payload));
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
    for (const cancel of [...this.waits.values()]) cancel();
    this.waits.clear();
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
    const answer = Promise.resolve()
      .then(() => rule.handle(payload, this.contextOf(rule.behavior)))
      .then(
        (outcome): CallAnswerToSend => {
          after = outcome.after;
          return answerOf(outcome);
        },
        (err: unknown): CallAnswerToSend => {
          this.log(
            `behavior ${rule.behavior.id}: ${action} failed: ${describe(err)}`,
          );
          return {
            kind: "error",
            code: "InternalError",
            description: `behavior ${rule.behavior.id} failed`,
          };
        },
      )
      .then((a) => {
        rule.busy = false;
        return a;
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
      random: (stream: string) =>
        seededStream(host.seed, cp.cpId, `${behavior.id}/${stream}`),
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
        return request;
      },
      raw(frame: string): void {
        cp.sendRaw(frame);
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
