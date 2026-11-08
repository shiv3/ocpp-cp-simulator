import type { BehaviorRegistry } from "../../../application/behavior/BehaviorRegistry";
import { BehaviorRegistry as DefaultBehaviorRegistry } from "../../../application/behavior/BehaviorRegistry";
import type { InboundCallPolicy } from "../../../domain/charge-point/ChargePoint";
import { csmsActionAliases } from "../../../domain/types/csmsActionNames";
import type { CallExchange } from "./CallExchange";

/**
 * The ordered checks an inbound CSMS CALL passes before the default path
 * (docs/concepts/charger-engine.md, "CallExchange and InboundCallGate"), once
 * for every OCPP version:
 *
 * 1. `incomingCallReceived`, announced to the scenario layer and the control plane
 * 2. `inboundPolicy` (sticky): reply with a CALLERROR, or stay silent
 * 3. `responseOverride` (one-shot): reply `{ status }`
 * 3b. the static capability profile (#618): reply CALLERROR `NotImplemented`
 *    for a disabled action
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
  takeOverride(action: string): { status: string } | "unhonoured" | null;
  /** Step 3b: does the station's capability profile disable `action`? */
  isDisabled?(action: string): boolean;
}

export interface InboundCallGateOptions {
  readonly ports: InboundCallGatePorts;
  /** Step 4. A registry that diverts nothing by default. */
  readonly registry?: BehaviorRegistry;
  /** Prefix of the gate's log lines, e.g. `"[v2.0.1] "`. */
  readonly logPrefix?: string;
  info(message: string): void;
  warn(message: string): void;
}

export class InboundCallGate {
  private readonly registry: BehaviorRegistry;
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
      this.options.info(
        `${this.prefix}Response override: ${action} → { status: "${override.status}" }`,
      );
      // The caller chose the status, and every other action the
      // responseOverride node lists answers `{ status }` too.
      exchange.reply({ status: override.status });
      return { kind: "settled" };
    }

    if (ports.isDisabled?.(action)) {
      // #618: the station is declared as lacking this feature. Below the
      // sticky policy and the one-shot override (a scenario keeps
      // precedence), above rules and handlers, which never see the CALL.
      this.options.warn(
        `${this.prefix}Capability profile: ${action} is not implemented, replied CallError(NotImplemented)`,
      );
      exchange.replyError("NotImplemented", "This action is not supported");
      return { kind: "settled" };
    }

    const connectorId = connectorIdOf(payload);
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
}

function connectorIdOf(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as {
    connectorId?: unknown;
    evseId?: unknown;
    evse?: { id?: unknown; connectorId?: unknown };
  };
  // This simulator maps an EVSE to a connector one to one, so on 2.x the EVSE
  // names the connector; `evse.connectorId` and `connectorId` are the index
  // within the EVSE, and only a CALL that names no EVSE falls back to them.
  if (typeof body.evseId === "number") return body.evseId;
  if (typeof body.evse?.id === "number") return body.evse.id;
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
  consumeResponseOverride(action: string): string | null;
  isActionDisabled?(action: string): boolean;
}): InboundCallGatePorts {
  return {
    isDisabled: (action) => chargePoint.isActionDisabled?.(action) ?? false,
    notifyReceived: (action, payload, messageId) =>
      chargePoint.notifyIncomingCall(action, payload, messageId),
    policyFor: (action) => chargePoint.getInboundCallPolicy(action),
    takeOverride: (action) => {
      const status = chargePoint.consumeResponseOverride(action);
      return status === null ? null : { status };
    },
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
    consumeResponseOverride(action: string): string | null;
    clearResponseOverride(action: string): void;
    isActionDisabled?(action: string): boolean;
  },
  statusless: ReadonlySet<string>,
): InboundCallGatePorts {
  return {
    isDisabled: (action) => chargePoint.isActionDisabled?.(action) ?? false,
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
      const status = chargePoint.consumeResponseOverride(armedUnder);
      for (const name of aliases) chargePoint.clearResponseOverride(name);
      if (statusless.has(action)) return "unhonoured";
      return status === null ? null : { status };
    },
  };
}
