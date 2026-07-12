import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

export interface WaitForBootAcceptedOptions {
  /** Bounded wait, defaults to 30s — see the timeout-policy note below. */
  readonly timeoutMs?: number;
  /** Called exactly once, only if the wait times out. */
  readonly onTimeout?: () => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve once boot has been accepted for `connectorId` — signaled by
 * EITHER the connector itself reaching Available (`connectorStatusChange`)
 * OR the CP-level boot gate opening (`statusChange` -> Available; see
 * `ChargePoint.onBootNotificationAccepted`). The CP-level fallback matters
 * for a connector restored mid-transaction: `onBootNotificationAccepted`
 * deliberately leaves its status alone (Charging/Preparing/etc.) instead of
 * resetting it to Available, so that connector alone would never emit the
 * Available transition this helper would otherwise wait for forever.
 *
 * Why this exists (issue #174): the CLI startup-scenario path
 * (`--scenario` / `--scenario-template` / `--scenario-template-file`, see
 * `runStartupScenario` in `startServer.ts`) used to call
 * `svc.runScenario()` immediately after `CLIChargePointService.connect()`
 * resolved. `connect()` only waits for the WebSocket `"connected"` event,
 * not for `BootNotification.conf` — so a scenario with no leading delay
 * before its first transaction node (e.g.
 * `cert16-tc005-ev-side-disconnect`) could send `StartTransaction.req`
 * while the boot gate was still closed. `OCPPMessageHandler.sendRequest`'s
 * `isCallAllowed` check silently drops any gated outgoing CALL sent before
 * Accepted — the scenario then falls back to a locally fabricated
 * `transactionId` (0) and the CSMS never sees the transaction at all. This
 * mirrors the gate the browser's `Connector.tsx` auto-start effect already
 * applies (`cpStatus === Available`) and the one `CLIChargePointService`
 * already applies to scenarios loaded via `loadScenario()` on an
 * already-running daemon (see `attachEventForwarders`'s `statusChange`
 * handler) — this helper brings the CLI's *startup* scenario path in line
 * with both.
 *
 * Timeout policy: bounded at `timeoutMs` (default 30s). We deliberately do
 * NOT abort the scenario on timeout — a CSMS that leaves boot in Pending
 * forever must not hang the CLI silently. `onTimeout` lets the caller log
 * a warning; the promise then resolves `false` and the caller is expected
 * to start the scenario anyway. Its outgoing CALLs will keep being dropped
 * by the boot gate until (if ever) the CSMS accepts — the same failure
 * mode as an operator starting a scenario by hand too early, which is
 * preferable to an operator's `--scenario` daemon run hanging forever on a
 * CSMS hiccup.
 */
export function waitForBootAccepted(
  chargePoint: ChargePoint,
  connectorId: number,
  options: WaitForBootAcceptedOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const isReady = (): boolean =>
    chargePoint.connectors.get(connectorId)?.status === OCPPStatus.Available ||
    chargePoint.status === OCPPStatus.Available;

  if (isReady()) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubStatus();
      unsubConnector();
      if (!result) {
        // `onTimeout` is caller-supplied (see startServer.ts's usage) and
        // must never prevent this promise from settling — a throwing
        // callback would otherwise leave the awaiting scenario hung
        // forever instead of proceeding per the timeout policy above.
        try {
          options.onTimeout?.();
        } catch (err) {
          console.error("[waitForBootAccepted] onTimeout callback threw:", err);
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    const unsubStatus = chargePoint.events.on("statusChange", ({ status }) => {
      if (status === OCPPStatus.Available) finish(true);
    });

    const unsubConnector = chargePoint.events.on(
      "connectorStatusChange",
      (evt) => {
        if (
          evt.connectorId === connectorId &&
          evt.status === OCPPStatus.Available
        ) {
          finish(true);
        }
      },
    );
  });
}
