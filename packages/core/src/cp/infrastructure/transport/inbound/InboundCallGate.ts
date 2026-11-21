import { encodeCallResultError } from "@ocpp-cp-simulator/ocpp-rpc/index";
import type { ChargePointBehaviorRegistry } from "../../../domain/engine/behaviorRules";
import { BehaviorRegistry as DefaultBehaviorRegistry } from "../../../application/behavior/BehaviorRegistry";
import type {
  InboundCallPolicy,
  ResponseOverrideSpec,
} from "../../../domain/charge-point/ChargePoint";
import { csmsActionAliases } from "../../../domain/types/csmsActionNames";
import type { CallExchange } from "./CallExchange";
import type { StationTopology } from "../../../domain/topology/StationTopology";

/**
 * The ordered checks an inbound CSMS CALL passes before the default path
 * (docs/concepts/charger-engine.md, "CallExchange and InboundCallGate"), once
 * for every OCPP version:
 *
 * 1. `incomingCallReceived`, announced to the scenario layer and the control plane
 * 2. `inboundPolicy` (sticky): reply with a CALLERROR, or stay silent
 * 3. `responseOverride` (one-shot, or repeated / persistent from the control
 *    plane): reply `{ status }`, or whatever else its mode says (a CALLERROR, a
 *    raw payload or frame, a CALLRESULTERROR, a delay, silence)
 * 3b. the static capability profile (#618): reply CALLERROR `NotImplemented`
 *    (or the profile's `disabledActionErrorCode`) for a disabled action, and
 *    `{ status: "NotImplemented" }` to a TriggerMessage /
 *    ExtendedTriggerMessage whose target it leaves out
 * 4. `BehaviorRegistry.resolve()`, synchronous
 * 5. otherwise: the default path, which the caller runs
 *
 * The gate is synchronous. A 2.x CALLRESULT is never deferred by a microtask
 * (#456), so the gate answers in the same turn it was asked.
 */

/** What the gate decided. */
export type GateDecision =
  /** The gate answered or suppressed the CALL; there is nothing left to do. */
  | { readonly kind: "settled" }
  /** Nothing intercepted it: run the default path. */
  | { readonly kind: "default" };

/**
 * How one OCPP version looks up policies and overrides. They differ only in
 * spelling: a 2.x CALL is looked up under its own name and its 1.6 alias
 * (`RequestStartTransaction` ← `RemoteStartTransaction`), a 1.6 one under its
 * own name.
 */
export interface InboundCallGatePorts {
  /** Step 1. */
  notifyReceived(action: string, payload: unknown, messageId: string): void;
  /** Step 2: the policy that applies to `action`, if any. */
  policyFor(action: string): InboundCallPolicy | undefined;
  /**
   * Step 3: consume the override armed for `action`. `null`: none armed.
   * `unhonoured`: one was armed (and is consumed) but the action's answer is
   * not a `{ status }`, so the real handler answers.
   */
  takeOverride(action: string): ResponseOverrideSpec | "unhonoured" | null;
  /** Step 3b: does the station's capability profile disable `action`? */
  isDisabled?(action: string): boolean;
  /** Step 3b: the CALLERROR code for a disabled action. Absent:
   *  `NotImplemented`. */
  disabledErrorCode?(): string;
  /** Step 3b: may TriggerMessage / ExtendedTriggerMessage request `target`
   *  under the capability profile? */
  isTriggerTargetSupported?(target: string): boolean;
}

export interface InboundCallGateOptions {
  readonly ports: InboundCallGatePorts;
  /** Step 4. A registry that diverts nothing by default. */
  readonly registry?: ChargePointBehaviorRegistry;
  /**
   * Checked after the CALL was announced: true leaves it unanswered and with
   * no effect (1.6 §4.2, while BootNotification is Rejected).
   */
  readonly silenced?: () => boolean;
  /**
   * How a 2.x `(evseId, connectorId)` maps to a domain connector (#628), to
   * pick the rules bound to that connector. Absent on 1.6, whose CALLs name
   * the domain connector directly.
   */
  readonly topology?: Pick<StationTopology, "connectorAt" | "connectorsOf">;
  /** Prefix of the gate's log lines, e.g. `"[v2.0.1] "`. */
  readonly logPrefix?: string;
  info(message: string): void;
  warn(message: string): void;
}

export class InboundCallGate {
  private readonly registry: ChargePointBehaviorRegistry;
  private readonly prefix: string;
  private readonly open = new Set<CallExchange>();

  constructor(private readonly options: InboundCallGateOptions) {
    this.registry = options.registry ?? new DefaultBehaviorRegistry();
    this.prefix = options.logPrefix ?? "";
  }

  /**
   * Follow an exchange until it ends, so a lost connection can abandon the
   * ones still waiting for their answer ({@link abandonAll}).
   */
  track(exchange: CallExchange): void {
    this.open.add(exchange);
    exchange.onClosed(() => this.open.delete(exchange));
  }

  /**
   * The connection went away: every exchange still open is abandoned, which
   * announces its CALL as unanswered. Answers that arrive later are not sent.
   */
  abandonAll(): void {
    for (const exchange of [...this.open]) exchange.abandon();
  }

  admit(exchange: CallExchange, payload: unknown): GateDecision {
    const { ports } = this.options;
    const action = exchange.action;
    ports.notifyReceived(action, payload, exchange.messageId);

    if (this.options.silenced?.()) {
      this.options.warn(
        `${this.prefix}Boot Rejected (§4.2): ignored ${action} (no response)`,
      );
      exchange.suppress();
      return { kind: "settled" };
    }

    const policy = ports.policyFor(action);
    if (policy) {
      if (policy.kind === "callerror") {
        this.options.warn(
          `${this.prefix}Inbound policy: replied CallError(${policy.errorCode}) to ${action}`,
        );
        exchange.replyError(policy.errorCode, policy.errorDescription);
      } else {
        this.options.warn(
          `${this.prefix}Inbound policy: ignored ${action} (no response)`,
        );
        exchange.suppress();
      }
      return { kind: "settled" };
    }

    const override = ports.takeOverride(action);
    if (override === "unhonoured") {
      // SetVariables / GetVariables answer something other than `{ status }`:
      // a canned status would be a schema-invalid answer, so the real handler
      // answers. Documented caveat, enforced here.
      this.options.warn(
        `${this.prefix}Response override armed for ${action} cannot be honoured (its response is not { status }); answering normally`,
      );
    } else if (override !== null) {
      if (override.mode === "delay") {
        // The handler answers as it would; only the write is held back.
        this.options.info(
          `${this.prefix}Response override: ${action} answer delayed ${override.delayMs} ms`,
        );
        exchange.delayAnswer(override.delayMs);
      } else {
        this.answerWithOverride(exchange, action, override);
        return { kind: "settled" };
      }
    }

    if (ports.isDisabled?.(action)) {
      // #618: the station is declared as lacking this feature. Below the
      // sticky policy and the one-shot override (a scenario keeps
      // precedence), above rules and handlers, which never see the CALL.
      // The code is the profile's choice of the two OCPP-J §4.2.3 codes
      // (`NotImplemented` unless `disabledActionErrorCode` says otherwise).
      const errorCode = ports.disabledErrorCode?.() ?? "NotImplemented";
      this.options.warn(
        `${this.prefix}Capability profile: ${action} is not implemented, replied CallError(${errorCode})`,
      );
      exchange.replyError(errorCode, "This action is not supported");
      return { kind: "settled" };
    }

    if (isTriggerAction(action) && ports.isTriggerTargetSupported) {
      const target = (payload as { requestedMessage?: unknown } | null)
        ?.requestedMessage;
      if (
        typeof target === "string" &&
        !ports.isTriggerTargetSupported(target)
      ) {
        // #618: the profile leaves this target out. Checked here, not in the
        // handlers, so a scenario rule or a code behavior cannot answer
        // Accepted for it. `NotImplemented` is the CALLRESULT status of
        // TriggerMessage and ExtendedTriggerMessage in every version.
        this.options.warn(
          `${this.prefix}Capability profile: ${action} for ${target} is not implemented, replied NotImplemented`,
        );
        exchange.reply({ status: "NotImplemented" });
        return { kind: "settled" };
      }
    }

    const connectorId = connectorIdOf(payload, this.options.topology);
    const resolution = this.registry.resolve(
      {
        action,
        payload,
        ...(connectorId === undefined ? {} : { connectorId }),
      },
      exchange,
    );
    if (resolution.kind !== "default") {
      return { kind: "settled" };
    }
    return { kind: "default" };
  }

  /** Answer `exchange` the way a non-`delay` override says. */
  private answerWithOverride(
    exchange: CallExchange,
    action: string,
    override: Exclude<ResponseOverrideSpec, { mode: "delay" }>,
  ): void {
    const { info, warn } = this.options;
    const prefix = `${this.prefix}Response override: ${action} → `;
    if (override.mode === "noAnswer") {
      warn(`${prefix}no answer`);
      exchange.suppress();
      return;
    }
    if (override.delayMs !== undefined && override.delayMs > 0) {
      exchange.delayAnswer(override.delayMs);
    }
    switch (override.mode) {
      case "status":
        // The caller chose the status, and every other action the
        // responseOverride node lists answers `{ status }` too.
        info(`${prefix}{ status: "${override.status}" }`);
        exchange.reply({ status: override.status });
        return;
      case "callError":
        warn(`${prefix}CallError(${override.errorCode})`);
        exchange.replyError(
          override.errorCode,
          override.errorDescription ?? "",
          override.errorDetails === undefined
            ? {}
            : { errorDetails: override.errorDetails },
        );
        return;
      case "callResult":
        warn(`${prefix}CALLRESULT with the given payload (not validated)`);
        exchange.reply(override.payload);
        return;
      case "raw":
        warn(`${prefix}raw frame (not validated)`);
        exchange.replyRaw(override.frame);
        return;
      case "callResultError":
        warn(`${prefix}CALLRESULTERROR(${override.errorCode})`);
        exchange.replyRaw(
          encodeCallResultError(
            exchange.messageId,
            override.errorCode,
            override.errorDescription ?? "",
            override.errorDetails,
          ),
          { outcome: "CallResult" },
        );
        return;
    }
  }
}

function isTriggerAction(action: string): boolean {
  return action === "TriggerMessage" || action === "ExtendedTriggerMessage";
}

/**
 * The domain connector a CALL names, for the rules bound to one connector.
 * 1.6 names it (`connectorId`). 2.x names an EVSE (`evseId` or `evse.id`) and
 * optionally the connector's index within it (`connectorId` beside `evseId`,
 * as in UnlockConnector, or `evse.connectorId`); the station topology
 * resolves the pair, and an EVSE alone stands for its first connector (its
 * only one on the 1:1 station). A pair the topology does not resolve names no
 * connector. Without a topology (1.6) and for a CALL that names no EVSE, the
 * plain `connectorId` / `evse.connectorId` is taken as is.
 */
function connectorIdOf(
  payload: unknown,
  topology: InboundCallGateOptions["topology"],
): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as {
    connectorId?: unknown;
    evseId?: unknown;
    evse?: { id?: unknown; connectorId?: unknown };
  };
  const evseId =
    typeof body.evseId === "number"
      ? body.evseId
      : typeof body.evse?.id === "number"
        ? body.evse.id
        : undefined;
  if (evseId !== undefined) {
    if (topology === undefined) return evseId;
    const index =
      typeof body.evseId === "number"
        ? body.connectorId
        : body.evse?.connectorId;
    if (typeof index === "number") return topology.connectorAt(evseId, index);
    // An EVSE the topology does not know keeps its id: it matches no
    // connector's rules, as before.
    return topology.connectorsOf(evseId)[0] ?? evseId;
  }
  if (typeof body.connectorId === "number") return body.connectorId;
  return typeof body.evse?.connectorId === "number"
    ? body.evse.connectorId
    : undefined;
}

/** The ports of a 1.6 charge point: one spelling per action. */
export function ports16(chargePoint: {
  notifyIncomingCall(
    action: string,
    payload: unknown,
    messageId?: string,
  ): void;
  getInboundCallPolicy(action: string): InboundCallPolicy | undefined;
  consumeResponse(action: string): ResponseOverrideSpec | null;
  isActionDisabled?(action: string): boolean;
  isTriggerTargetSupported?(target: string): boolean;
  disabledActionErrorCode?(): string;
}): InboundCallGatePorts {
  return {
    isDisabled: (action) => chargePoint.isActionDisabled?.(action) ?? false,
    disabledErrorCode: () =>
      chargePoint.disabledActionErrorCode?.() ?? "NotImplemented",
    isTriggerTargetSupported: (target) =>
      chargePoint.isTriggerTargetSupported?.(target) ?? true,
    notifyReceived: (action, payload, messageId) =>
      chargePoint.notifyIncomingCall(action, payload, messageId),
    policyFor: (action) => chargePoint.getInboundCallPolicy(action),
    takeOverride: (action) => chargePoint.consumeResponse(action),
  };
}

/**
 * The ports of a 2.x charge point. A scenario spells an action in either
 * version's vocabulary, so a CALL is looked up under its own name and its
 * aliases. `statusless` lists the actions whose response is not `{ status }`.
 */
export function portsAliased(
  chargePoint: {
    notifyIncomingCall(
      action: string,
      payload: unknown,
      messageId?: string,
    ): void;
    getInboundCallPolicy(action: string): InboundCallPolicy | undefined;
    hasResponseOverride(action: string): boolean;
    consumeResponse(action: string): ResponseOverrideSpec | null;
    clearResponseOverride(action: string): void;
    isActionDisabled?(action: string): boolean;
    isTriggerTargetSupported?(target: string): boolean;
    disabledActionErrorCode?(): string;
  },
  statusless: ReadonlySet<string>,
): InboundCallGatePorts {
  return {
    isDisabled: (action) => chargePoint.isActionDisabled?.(action) ?? false,
    disabledErrorCode: () =>
      chargePoint.disabledActionErrorCode?.() ?? "NotImplemented",
    isTriggerTargetSupported: (target) =>
      chargePoint.isTriggerTargetSupported?.(target) ?? true,
    notifyReceived: (action, payload, messageId) =>
      chargePoint.notifyIncomingCall(action, payload, messageId),
    policyFor: (action) => {
      const name = csmsActionAliases(action).find(
        (candidate) =>
          chargePoint.getInboundCallPolicy(candidate) !== undefined,
      );
      return name === undefined
        ? undefined
        : chargePoint.getInboundCallPolicy(name);
    },
    takeOverride: (action) => {
      const aliases = csmsActionAliases(action);
      const armedUnder = aliases.find((name) =>
        chargePoint.hasResponseOverride(name),
      );
      if (armedUnder === undefined) return null;
      // One CALL consumes the one-shot under every spelling it was armed
      // with, so a copy left under the other name cannot fire on a later,
      // unrelated call.
      const spec = chargePoint.consumeResponse(armedUnder);
      // A one-shot arm is spent by the consume above; the copy under the
      // other spelling goes too. A repeated or persistent arm stays, with the
      // one spelling it was armed under.
      if (!chargePoint.hasResponseOverride(armedUnder)) {
        for (const name of aliases) chargePoint.clearResponseOverride(name);
      }
      if (spec === null) return null;
      // `{ status }` is not the answer of these actions; every other mode
      // names its own answer.
      if (spec.mode === "status" && statusless.has(action)) return "unhonoured";
      return spec;
    },
  };
}
