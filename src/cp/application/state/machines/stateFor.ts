import { state, type Transition } from "robot3";

/**
 * robot3's `state()` infers its event type from the first transition alone,
 * so a state with several events does not type-check. Returns a `state()`
 * pinned to a machine's full event union.
 */
export const stateFor =
  <E extends string>() =>
  (...transitions: Transition<E>[]) =>
    state(...transitions);
