import { ScenarioExecutor } from "../../src/cp/application/scenario/ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../../src/cp/application/scenario/ScenarioRuntime";
import type {
  ScenarioDefinition,
  ScenarioEvents,
} from "../../src/cp/application/scenario/ScenarioTypes";
import { EventEmitter } from "../../src/cp/shared/EventEmitter";
import type { ChargePoint } from "../../src/cp/domain/charge-point/ChargePoint";

const DEFAULT_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 10_000;
const POLL_MS = 25;

interface RunScenarioOptions {
  onParkStart?: () => Promise<void> | void;
  onParkStop?: () => Promise<void> | void;
  timeoutMs?: number;
}

export interface ScenarioRunResult {
  completed: boolean;
  errored: boolean;
  error?: unknown;
}

export async function runScenario(
  cp: ChargePoint,
  def: ScenarioDefinition,
  {
    onParkStart,
    onParkStop,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: RunScenarioOptions = {},
): Promise<ScenarioRunResult> {
  const connector = cp.getConnector(1);
  if (!connector) {
    throw new Error("Connector 1 is required for scenario e2e tests");
  }

  const callbacks = createScenarioExecutorCallbacks({
    chargePoint: cp,
    connector,
  });
  const originalOnStartTransaction = callbacks.onStartTransaction;
  callbacks.onStartTransaction = async (...args) => {
    await originalOnStartTransaction?.(...args);
    await waitUntil(() => {
      const transaction = connector.transaction;
      return (
        (transaction?.id ?? 0) > 0 ||
        (typeof transaction?.cpTransactionId === "string" &&
          transaction.cpTransactionId.length > 0)
      );
    }, WAIT_TIMEOUT_MS);
  };

  const events = new EventEmitter<ScenarioEvents>();
  let completed = false;
  let errored = false;
  let errorInfo: unknown;

  events.on("execution.completed", () => {
    completed = true;
  });
  events.on("executionCompleted", () => {
    completed = true;
  });
  events.on("execution.error", (info) => {
    errored = true;
    errorInfo = info;
  });
  events.on("executionError", (info) => {
    errored = true;
    errorInfo = info;
  });

  const executor = new ScenarioExecutor(def, callbacks, events);
  let keepWatching = true;
  const done = executor.start().finally(() => {
    keepWatching = false;
  });
  const watchers = [
    watchParkFlag(
      () => cp.isScenarioHandled(1),
      () => keepWatching,
      onParkStart,
    ),
    watchParkFlag(
      () => cp.isScenarioStopHandled(1),
      () => keepWatching,
      onParkStop,
    ),
  ];
  const watcherFailure = rejectOnWatcherFailure(watchers);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`Scenario "${def.name}" timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  try {
    await Promise.race([done, watcherFailure, timeoutPromise]);
    // `done` won the race (a timeout or an in-flight watcher rejection would
    // have thrown into catch). The scenario reached its end — but a park
    // callback (onParkStart/onParkStop, e.g. a CSMS-command assertion) may
    // have rejected at or just after that moment; surface it rather than let
    // the finally's Promise.allSettled swallow it.
    keepWatching = false;
    const settled = await Promise.allSettled(watchers);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) {
      executor.stop();
      throw rejected.reason;
    }
    return {
      completed,
      errored,
      ...(errorInfo === undefined ? {} : { error: errorInfo }),
    };
  } catch (error) {
    keepWatching = false;
    executor.stop();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    keepWatching = false;
    await Promise.allSettled(watchers);
  }
}

export async function waitUntil(
  pred: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (pred()) return;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function watchParkFlag(
  isParked: () => boolean,
  shouldContinue: () => boolean,
  callback?: () => Promise<void> | void,
): Promise<void> {
  if (!callback) return Promise.resolve();

  return (async () => {
    while (shouldContinue()) {
      if (isParked()) {
        await callback();
        return;
      }
      await sleep(POLL_MS);
    }
  })();
}

function rejectOnWatcherFailure(watchers: Promise<void>[]): Promise<never> {
  return new Promise((_, reject) => {
    for (const watcher of watchers) {
      watcher.catch(reject);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
