import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock, TimerHandle } from "../../shared/clock";
import type { LocalOnlyDecision } from "../auth/LocalAuthorizationResolver";
import type { LocalAuthListManager } from "../auth/LocalAuthList";
import type {
  CsmsAuthorizationResult,
  StationAuthorization,
} from "../auth/StationAuthorization";
import type { Connector } from "../connector/Connector";
import type { IdTokenTypeName } from "../connector/Transaction";
import { isOcpp2Version } from "../types/OcppVersion";
import { OCPPStatus } from "../types/OcppTypes";
import type { ChargePoint } from "./ChargePoint";
import type { ChargePointEvents } from "./ChargePointEvents";

/** What the authorization flow needs from its charge point. */
export interface AuthorizationFlowHost {
  /** Public members go through it so spies on the charge point still see
   *  them (`authorize`, `isOnline`, `updateConnectorStatus`). */
  readonly chargePoint: Pick<
    ChargePoint,
    | "authorize"
    | "configuration"
    | "isOnline"
    | "ocppVersion"
    | "sendStatusNotificationRaw"
    | "status"
    | "updateConnectorStatus"
  >;
  readonly authorization: () => StationAuthorization;
  readonly clock: () => SimClock;
  readonly localAuthListManager: () => LocalAuthListManager;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly logger: () => Logger;
}

/**
 * Local-start authorization of one charge point: the wait for
 * Authorize.conf with the offline and timeout fallbacks, and the
 * energy hold after a non-Accepted id. The charge point keeps the public
 * methods as thin delegates.
 */
export class AuthorizationFlow {
  /** Parent id / groupIdToken of the tags the CSMS authorized (reservations). */
  private readonly _authorizedParents = new Map<string, string>();

  constructor(private readonly host: AuthorizationFlowHost) {}

  /**
   * The parent id (1.6) or groupIdToken (2.x) the station knows for `idTag`:
   * Local Authorization List, then Authorization Cache, then the last
   * Authorize.conf (kept even when the cache is off). Reservation matching by
   * parent (1.6 §5.13, H03.FR.04/07) uses it; it never asks the CSMS itself.
   */
  knownParentIdOf(idTag: string): string | undefined {
    // A malformed CALL (warn mode runs the handler anyway) can name no tag.
    if (typeof idTag !== "string") return undefined;
    return (
      this.host.localAuthListManager().getEntry(idTag)?.parentIdTag ??
      this.host.authorization().cache.get(idTag)?.parentId ??
      this._authorizedParents.get(idTag)
    );
  }

  /** Feed a CSMS verdict on `idToken` to the Authorization Cache (#452) and
   *  report a conflict with the Local Authorization List (#744):
   *  called by the Authorize / StartTransaction / StopTransaction result
   *  handlers. A no-op while the cache is disabled or for an identifier of
   *  the Local Authorization List (1.6 §3.5.3). */
  recordAuthorizationResult(
    idToken: string,
    result: CsmsAuthorizationResult,
  ): void {
    if (result.parentId !== undefined) {
      this._authorizedParents.set(idToken, result.parentId);
    } else {
      this._authorizedParents.delete(idToken);
    }
    if (this.host.authorization().recordCsmsResult(idToken, result)) {
      this.host
        .logger()
        .debug(
          `Authorization cache updated: ${idToken} → ${result.status}`,
          LogType.TRANSACTION,
        );
    }
    // 1.6 §3.5.2: tell the CSMS when its verdict contradicts the Local
    // Authorization List. 2.x has no such notification (its StatusNotification
    // carries no errorCode).
    if (
      !isOcpp2Version(this.host.chargePoint.ocppVersion) &&
      this.host.authorization().conflictsWithLocalList(idToken, result.status)
    ) {
      this.host
        .logger()
        .warn(
          `CSMS verdict ${result.status} for ${idToken} conflicts with the Local Authorization List; sending LocalListConflict`,
          LogType.OCPP,
        );
      this.host.chargePoint.sendStatusNotificationRaw(
        0,
        this.host.chargePoint.status,
        {
          errorCode: "LocalListConflict",
        },
      );
    }
  }

  /** ClearCache (1.6 §5.4): empty the Authorization Cache. Returns whether
   *  it could be cleared. */
  clearAuthorizationCache(): boolean {
    return this.host.authorization().clearCache();
  }

  holdEnergyOnInvalidId(connector: Connector): void {
    const allowance =
      this.host.chargePoint.configuration.maxEnergyOnInvalidId();
    if (connector.holdEnergyForInvalidId(allowance)) {
      this.reportEnergyHeld(connector);
    }
  }

  reportEnergyHeld(connector: Connector): void {
    if (!connector.hasRunningTransaction) return;
    if (
      connector.status === OCPPStatus.Charging ||
      connector.status === OCPPStatus.Preparing ||
      connector.status === OCPPStatus.SuspendedEV
    ) {
      this.host
        .logger()
        .info(
          `Connector ${connector.id} energy delivery stopped after a non-Accepted id → SuspendedEVSE`,
          LogType.TRANSACTION,
        );
      this.host.chargePoint.updateConnectorStatus(
        connector.id,
        OCPPStatus.SuspendedEVSE,
      );
    }
  }

  authorizeAndWait(
    tagId: string,
    timeoutMs = 10000,
    idTokenType?: IdTokenTypeName,
    options: { failClosed?: boolean } = {},
  ): Promise<string> {
    const decision = this.host
      .authorization()
      .decide(tagId, this.host.chargePoint.isOnline());
    if (decision.kind !== "askCsms") {
      return Promise.resolve(this.localAuthorizationStatus(tagId, decision));
    }

    const queued = isOcpp2Version(this.host.chargePoint.ocppVersion);
    let armTimeout: () => void = () => undefined;
    let onNotSent: () => void = () => undefined;
    const result = new Promise<string>((resolve) => {
      let settled = false;
      let timeoutId: TimerHandle | null = null;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeoutId) this.host.clock().clearTimeout(timeoutId);
        this.host.events().off("authorizeResult", handler);
        this.host.events().off("disconnected", disconnectHandler);
      };

      const handler = (data: { tagId: string; status: string }) => {
        if (data.tagId !== tagId) return;
        cleanup();
        resolve(data.status);
      };

      const decideOffline = (why: string) => {
        const status = this.localAuthorizationStatus(
          tagId,
          this.host.authorization().decideOffline(tagId),
        );
        this.host
          .logger()
          .warn(
            `${why} while awaiting Authorize.conf for ${tagId}; offline authorization: ${status}`,
            LogType.TRANSACTION,
          );
        resolve(status);
      };

      const disconnectHandler = () => {
        cleanup();
        decideOffline("Disconnected");
      };

      this.host.events().on("authorizeResult", handler);
      this.host.events().on("disconnected", disconnectHandler);

      const waitMs = queued
        ? Math.max(
            timeoutMs,
            this.host.chargePoint.configuration.messageTimeout() * 1000,
          )
        : timeoutMs;
      armTimeout = () => {
        if (settled || timeoutId) return;
        timeoutId = this.host.clock().setTimeout(onTimeout, waitMs);
      };

      const onTimeout = () => {
        cleanup();
        if (!this.host.chargePoint.isOnline()) {
          decideOffline(`Timeout (${waitMs}ms) and offline`);
          return;
        }
        const refusal = this.host.authorization().decideUnanswered(tagId);
        if (refusal) {
          this.host
            .logger()
            .warn(
              `Timeout (${timeoutMs}ms) awaiting Authorize.conf for ${tagId}; falling back to the local decision`,
              LogType.TRANSACTION,
            );
          resolve(this.localAuthorizationStatus(tagId, refusal));
          return;
        }
        if (options.failClosed) {
          this.host
            .logger()
            .warn(
              `Timeout (${waitMs}ms) awaiting Authorize.conf for ${tagId}; not authorized (${queued ? "F01.FR.01" : "§5.11"})`,
              LogType.TRANSACTION,
            );
          resolve("Unknown");
          return;
        }
        this.host
          .logger()
          .warn(
            `Timeout (${waitMs}ms) awaiting Authorize.conf for ${tagId}; proceeding as Accepted`,
            LogType.TRANSACTION,
          );
        resolve("Accepted");
      };

      // Never written (not connected, dropped, socket closed): offline the
      // offline rules decide at once, otherwise the timeout decides, as for
      // an unanswered CALL.
      onNotSent = () => {
        if (settled) return;
        if (!this.host.chargePoint.isOnline()) {
          cleanup();
          decideOffline("Authorize not sent");
          return;
        }
        armTimeout();
      };

      // The listeners and timer are set before the CALL goes out, so a
      // synchronous write arms the timer.
      if (queued) {
        this.host.chargePoint.authorize(tagId, idTokenType, {
          onWritten: () => armTimeout(),
          onDropped: () => onNotSent(),
        });
      } else {
        if (idTokenType === undefined) this.host.chargePoint.authorize(tagId);
        else this.host.chargePoint.authorize(tagId, idTokenType);
        armTimeout();
      }
    });

    return result;
  }

  private localAuthorizationStatus(
    tagId: string,
    decision: LocalOnlyDecision,
  ): string {
    if (decision.kind === "accept") {
      this.host
        .logger()
        .info(
          `${tagId} authorized locally (${decision.source}); no Authorize.req sent`,
          LogType.TRANSACTION,
        );
      return "Accepted";
    }
    this.host
      .logger()
      .warn(
        `${tagId} refused locally (${decision.source}): ${decision.status}`,
        LogType.TRANSACTION,
      );
    return decision.status;
  }
}
