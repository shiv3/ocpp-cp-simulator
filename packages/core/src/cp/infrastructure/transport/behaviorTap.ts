/**
 * What the transport handlers need from the charger engine's behavior layer:
 * the `beforeSend` chain and the observed events. Declared here, structurally,
 * so the transport does not import the application layer.
 */
export interface BehaviorTap {
  beforeSend(
    action: string,
    payload: unknown,
  ): { readonly drop: true } | { readonly payload: unknown };
  observe(
    event:
      | {
          type: "callResult";
          action: string;
          messageId: string;
          outcome: "result" | "error";
          payload: unknown;
        }
      | {
          type: "callReceived";
          action: string;
          messageId: string;
          payload: unknown;
        },
  ): void;
}

const PASS_THROUGH: BehaviorTap = {
  beforeSend: (_action, payload) => ({ payload }),
  observe: () => undefined,
};

/**
 * The tap of a charge point. A hand-written station double in a unit test has
 * no engine; it gets a tap that changes and reports nothing.
 */
export function behaviorTapOf(chargePoint: unknown): BehaviorTap {
  const engine = (chargePoint as { engine?: BehaviorTap } | null)?.engine;
  return engine ?? PASS_THROUGH;
}
