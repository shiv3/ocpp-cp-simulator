import { CallWaiters as RpcCallWaiters } from "@ocpp-cp-simulator/ocpp-rpc/index";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";

/**
 * ocpp-rpc's CallWaiters (#978) on the simulator's clock: the timeout runs on
 * `realClock` unless a `SimClock` getter is given, read when a waiter is
 * registered (#348 DataTransfer, #389 expert calls).
 */
export class CallWaiters<T> extends RpcCallWaiters<T> {
  constructor(
    timeoutMs: number,
    timeoutError: (id: string) => Error,
    clock: () => SimClock = () => realClock,
  ) {
    super(timeoutMs, timeoutError, clock);
  }
}
