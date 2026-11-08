import type { CPRegistry } from "./CPRegistry";

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
 * carried it comes back. A stop queued because the socket is down is never
 * written, so it cannot be delivered: it is not waited for, and the
 * message stays in the persistent queue for the next start. `waitMs` bounds
 * the whole wait, not each charge point.
 */
export async function stopTransactionsAndWait(
  registry: Pick<CPRegistry, "list" | "get">,
  waitMs: number,
  log: (line: string) => void = () => {},
  skip: Promise<void> = new Promise<void>(() => {}),
): Promise<ShutdownStopReport> {
  let skipped = false;
  void skip.then(() => {
    skipped = true;
    wake?.();
  });
  const unsubscribes: Array<() => void> = [];
  const awaiting = new Set<string>(); // message ids sent, not yet answered
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
    for (const cpId of registry.list()) {
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
              awaiting.add(`${cpId}/${frame.id}`);
            } else if (
              direction === "Received" &&
              (frame.type === 3 || frame.type === 4) &&
              awaiting.delete(`${cpId}/${frame.id}`)
            ) {
              delivered++;
              notify();
            }
          }),
        );
      }
      for (const connectorId of connectors) {
        try {
          // 1.6 `Reason` Other ("any other reason"); 2.x has no value for a
          // station going down, and StopAuthorized (the default) would claim
          // an EV driver authorized the stop, so name AbnormalCondition.
          svc.stopTransaction(connectorId, {
            reason: "Other",
            triggerReason: "AbnormalCondition",
          });
          mine.add(connectorId);
          stopped++;
          if (online) expected++;
        } catch (err) {
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
  if (timedOut) {
    log(
      `${expected - delivered} stop(s) not answered within ${waitMs} ms; they are queued when the sockets close and replayed on the next start (kept across restarts only with --state-db)`,
    );
  }
  return { stopped, delivered, timedOut };
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

/** A TransactionEvent carries many things; only `Ended` closes a session. */
function isStop(action: string | undefined, payload: unknown): boolean {
  if (action === "StopTransaction") return true;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { eventType?: unknown }).eventType === "Ended"
  );
}
