/**
 * A wait the scenario runtime hands to the executor. The promise type in
 * `ScenarioExecutorCallbacks` stays a plain `Promise`, so callers that did
 * not arm a wait still type-check; waits that did carry `cancel`.
 */
export type CancellablePromise<T> = Promise<T> & { cancel?: () => void };

export interface CancellableWait<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export const cancellablePromise = <T>({
  promise,
  cancel,
}: CancellableWait<T>): CancellablePromise<T> => {
  const wrapped = promise.finally(cancel) as CancellablePromise<T>;
  wrapped.cancel = cancel;
  return wrapped;
};

/** Withdraws `promise`'s wait if it is a {@link CancellablePromise}. */
export const cancelIfCancellable = (promise: Promise<unknown>): void => {
  (promise as CancellablePromise<unknown>).cancel?.();
};
