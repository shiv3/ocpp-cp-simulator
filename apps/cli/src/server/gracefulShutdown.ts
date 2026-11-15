import type { StopReason } from "@ocpp-cp-simulator/contracts/transactionVocabulary";
import type { CPRegistry } from "./CPRegistry";

/**
 * The 1.6 StopTransaction `reason` (2.x `stoppedReason`) of a stop the
 * daemon makes on its own: a shutdown (#622) or an opt-in `cp.delete` /
 * `disconnect` with `stopTransactions`. OCPP 1.6 §7.41 Reason `Other`: the
 * stop is neither the EV driver's (`Local`: "stopped locally on request of the
 * user at the Charge Point") nor the CSMS's (`Remote`). 2.0.1 E06 /
 * ReasonEnumType spells it the same.
 */
export const DAEMON_STOP_REASON: StopReason = "Other";

/** What to stop, and with which reason. */
export interface StopScope {
  /** Only these charge points; absent = every one of the registry. */
  readonly cpIds?: readonly string[];
  /** Default {@link DAEMON_STOP_REASON}. */
  readonly reason?: StopReason;
}

/** What a graceful shutdown found and did, for the log line and tests. */
export interface ShutdownStopReport {
  /** Transactions the shutdown stopped. */
  readonly stopped: number;
  /** Of those, how many the CSMS answered before the wait ended. */
  readonly delivered: number;
  /** True when the time limit ended the wait with stops still unanswered. */
  readonly timedOut: boolean;
}

/** The action names whose answer settles a stopped transaction: OCPP 1.6
 *  StopTransaction, OCPP 2.x TransactionEvent(Ended). */
const STOP_ACTIONS = new Set(["StopTransaction", "TransactionEvent"]);

/**
 * Stop every running transaction of the registry and wait, up to `waitMs`,
 * until the CSMS has answered the stops (#622).
 *
 * A stop is "delivered" when the CALLRESULT or CALLERROR for the frame that
 * carried it comes back. Only the stops this call made count: a stop frame
 * is tracked when it carries the transaction id of a transaction this call
 * stopped, so a stop sent meanwhile by something else (a scenario, a
 * replayed queue) and its answer do not end the wait early. A stop queued because the socket is down is never
 * written, so it cannot be delivered: it is not waited for, and the
 * message stays in the persistent queue for the next start. `waitMs` bounds
 * the whole wait, not each charge point.
 *
 * `scope` narrows it to some charge points (an opt-in `cp.delete` /
 * `disconnect` with `stopTransactions`, see
 * {@link stopChargePointTransactionsAndWait}) and names the reason.
 */
export async function stopTransactionsAndWait(
  registry: Pick<CPRegistry, "list" | "get">,
  waitMs: number,
  log: (line: string) => void = () => {},
  skip: Promise<void> = new Promise<void>(() => {}),
  scope: StopScope = {},
): Promise<ShutdownStopReport> {
  const reason = scope.reason ?? DAEMON_STOP_REASON;
  const targets = (): readonly string[] => scope.cpIds ?? registry.list();
  let skipped = false;
  void skip.then(() => {
    skipped = true;
    wake?.();
  });
  const unsubscribes: Array<() => void> = [];
  // Message ids of the stop frames this call made → the transaction's key.
  const awaiting = new Map<string, string>();
  // Per charge point: wire ids of the transactions this call stopped, and
  // whether the stop of each has been answered. A 1.6 transaction whose id
  // is not assigned yet is a placeholder `?<n>` that the first untracked
  // stop frame of that charge point claims.
  const ours = new Map<string, Map<string, boolean>>();
  let placeholders = 0;
  const claim = (cpId: string, wireId: string | undefined): string | null => {
    const mine = ours.get(cpId);
    if (!mine) return null;
    if (wireId !== undefined && mine.has(wireId)) return wireId;
    for (const key of mine.keys()) {
      if (!key.startsWith("?")) continue;
      // A placeholder becomes the id the frame carries.
      const answered = mine.get(key) ?? false;
      mine.delete(key);
      const resolved = wireId ?? key;
      mine.set(resolved, answered);
      return resolved;
    }
    return null;
  };
  let stopped = 0;
  // Stops of charge points that are online: the only ones that can be answered.
  let expected = 0;
  let delivered = 0;
  let wake: (() => void) | null = null;
  const notify = () => wake?.();

  const watched = new Set<string>(); // charge points with a frame listener
  // Connectors this run stopped and still reports open; a key leaves when the
  // connector is seen closed, so a transaction opened later is stopped too.
  const stoppedOn = new Map<string, Set<number>>();
  /** One pass over the registry: stop every transaction still open. Run
   *  again while waiting, because a `start_transaction` command, a scenario or
   *  background traffic can open one after the first pass. */
  const stopPass = (): void => {
    for (const cpId of targets()) {
      const svc = registry.get(cpId);
      if (!svc) continue;
      const open = svc.openTransactionConnectorIds();
      const mine = stoppedOn.get(cpId) ?? new Set<number>();
      stoppedOn.set(cpId, mine);
      for (const id of [...mine]) if (!open.includes(id)) mine.delete(id);
      const connectors = open.filter((id) => !mine.has(id));
      if (connectors.length === 0) continue;
      // A SOAP charge point has no JSON frames to watch: its answer cannot be
      // observed here, so it is stopped but never waited for.
      const soap = svc.isSoapChargePoint();
      const online = svc.isOnline() && !soap;
      if (!watched.has(cpId) && !soap) {
        watched.add(cpId);
        unsubscribes.push(
          svc.onWireFrame((direction, raw) => {
            const frame = parseFrame(raw);
            if (!frame) return;
            if (
              direction === "Sent" &&
              frame.type === 2 &&
              STOP_ACTIONS.has(frame.action ?? "") &&
              isStop(frame.action, frame.payload)
            ) {
              const key = claim(cpId, stopWireId(frame.payload));
              if (key !== null) awaiting.set(`${cpId}/${frame.id}`, key);
            } else if (
              direction === "Received" &&
              (frame.type === 3 || frame.type === 4)
            ) {
              const messageKey = `${cpId}/${frame.id}`;
              const key = awaiting.get(messageKey);
              if (key === undefined) return;
              awaiting.delete(messageKey);
              const mine = ours.get(cpId);
              if (mine && mine.get(key) === false) {
                mine.set(key, true);
                delivered++;
                notify();
              }
            }
          }),
        );
      }
      for (const connectorId of connectors) {
        // Tracked before the stop: its frame is written during the call.
        const wireId =
          svc.transactionWireId(connectorId) ?? `?${++placeholders}`;
        const tracked = ours.get(cpId) ?? new Map<string, boolean>();
        ours.set(cpId, tracked);
        if (online) tracked.set(wireId, false);
        try {
          // 1.6 `Reason` Other ("any other reason") unless the caller named
          // one; 2.x has no trigger for a station going down or being taken
          // away, and StopAuthorized (the default) would claim an EV driver
          // authorized the stop, so name AbnormalCondition.
          svc.stopTransaction(connectorId, {
            reason,
            triggerReason: "AbnormalCondition",
          });
          mine.add(connectorId);
          stopped++;
          if (online) expected++;
        } catch (err) {
          tracked.delete(wireId);
          log(
            `Could not stop the transaction on ${cpId} connector ${connectorId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  };
  stopPass();

  if (stopped === 0) return { stopped, delivered, timedOut: false };
  log(
    expected > 0
      ? `Stopped ${stopped} transaction(s); waiting up to ${waitMs} ms for ${expected} answer(s)`
      : `Stopped ${stopped} transaction(s); no charge point is online, the stops stay queued`,
  );

  const deadline = Date.now() + Math.max(0, waitMs);
  // Done when every stop of an online charge point has been answered. Stops of
  // an offline one cannot be, and are not waited for.
  let timedOut = false;
  while (!skipped) {
    stopPass();
    if (delivered >= expected) break;
    const left = deadline - Date.now();
    if (left <= 0) {
      timedOut = true;
      break;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(left, 100));
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  }
  for (const off of unsubscribes) off();
  // Stops this call wrote but that are unanswered when the wait ends (limit
  // or second signal) would be dropped by the close: queue them for the
  // next start.
  if (delivered < expected) {
    const unanswered = new Set<string>();
    for (const [messageKey, key] of awaiting) {
      const cpId = messageKey.slice(0, messageKey.lastIndexOf("/"));
      if (ours.get(cpId)?.get(key) === false) unanswered.add(cpId);
    }
    for (const cpId of unanswered) {
      try {
        if (registry.get(cpId)?.queueUnansweredStop()) {
          log(`Queued the unanswered stop of ${cpId} for the next start`);
        }
      } catch (err) {
        log(
          `Could not queue the unanswered stop of ${cpId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (timedOut) {
    log(
      `${expected - delivered} stop(s) not answered within ${waitMs} ms; they are queued and replayed on the next start (kept across restarts only with --state-db)`,
    );
  }
  return { stopped, delivered, timedOut };
}

/**
 * One charge point's share of the shutdown stop: stop its running
 * transactions and wait, up to `waitMs`, for the CSMS to answer them, before
 * an opt-in `cp.delete` or `disconnect` (`stopTransactions: true`) closes it.
 * Same delivery rules as {@link stopTransactionsAndWait}: an offline charge
 * point's stops are queued, not waited for.
 */
export function stopChargePointTransactionsAndWait(
  registry: Pick<CPRegistry, "list" | "get">,
  cpId: string,
  waitMs: number,
  options: {
    readonly reason?: StopReason;
    readonly log?: (line: string) => void;
  } = {},
): Promise<ShutdownStopReport> {
  return stopTransactionsAndWait(registry, waitMs, options.log, undefined, {
    cpIds: [cpId],
    reason: options.reason,
  });
}

interface Frame {
  type: number;
  id: string;
  action?: string;
  payload?: unknown;
}

function parseFrame(raw: string): Frame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || typeof parsed[1] !== "string") return null;
    const type = parsed[0];
    if (typeof type !== "number") return null;
    return {
      type,
      id: parsed[1],
      action: type === 2 ? String(parsed[2]) : undefined,
      payload: type === 2 ? parsed[3] : undefined,
    };
  } catch {
    return null;
  }
}

/** The transaction id a stop frame carries: 1.6 StopTransaction
 *  `transactionId`, 2.x TransactionEvent `transactionInfo.transactionId`. */
function stopWireId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as {
    transactionId?: unknown;
    transactionInfo?: { transactionId?: unknown };
  };
  const id = p.transactionInfo?.transactionId ?? p.transactionId;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

/** A TransactionEvent carries many things; only `Ended` closes a session. */
function isStop(action: string | undefined, payload: unknown): boolean {
  if (action === "StopTransaction") return true;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { eventType?: unknown }).eventType === "Ended"
  );
}
