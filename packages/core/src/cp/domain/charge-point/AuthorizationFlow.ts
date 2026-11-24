import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock, TimerHandle } from "../../shared/clock";
import { DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES } from "../auth/AuthorizationCache";
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
/** The most parents {@link AuthorizationFlow} keeps from CSMS verdicts
 *  (#839); the least recently recorded one goes first. */
export const MAX_AUTHORIZED_PARENTS = DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES;

export class AuthorizationFlow {
  /** Parent id / groupIdToken of the tags the CSMS authorized (reservations),
   *  in recording order, bounded by {@link MAX_AUTHORIZED_PARENTS}. */
  private readonly _authorizedParents = new Map<string, string>();

  constructor(private readonly host: AuthorizationFlowHost) {}

  /**
   * The parent id (1.6) or groupIdToken (2.x) the station knows for `idTag`:
   * Local Authorization List, then Authorization Cache, then the last
   * Authorize.conf (kept even when the cache is off, until a reset, for at
   * most {@link MAX_AUTHORIZED_PARENTS} tags, #839). Reservation matching by
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
    // Delete first so a new verdict moves the tag to the newest position.
    this._authorizedParents.delete(idToken);
    if (result.parentId !== undefined) {
      this._authorizedParents.set(idToken, result.parentId);
      if (this._authorizedParents.size > MAX_AUTHORIZED_PARENTS) {
        const oldest = this._authorizedParents.keys().next().value;
        if (oldest !== undefined) this._authorizedParents.delete(oldest);
      }
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

  /** A reset reboots the station: the parents the CSMS verdicts carried are
   *  volatile memory and do not survive it (#839). The Authorization Cache
   *  is left alone. */
  forgetAuthorizedParents(): void {
    this._authorizedParents.clear();
  }

  /** ClearCache (1.6 §5.4): empty the Authorization Cache. Returns whether
   *  it could be cleared. */
  clearAuthorizationCache(): boolean {
    return this.host.authorization().clearCache();
  }

  /**
   * `StopTransactionOnInvalidId=false` and the id was not accepted: keep the
   * transaction but stop the energy delivery (2.0.1
   * E05.FR.02/03, C15.FR.06; 2.x only, 1.6 errata 3.17 is #736). With `MaxEnergyOnInvalidId` > 0 that much energy
   * is delivered first; the connector reports SuspendedEVSE either way once
   * the delivery has stopped.
   */
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

  /**
   * Authorize `tagId` for a local start (issues #181, #452). Resolves with
   * an idTagInfo/idTokenInfo status ("Accepted", "Invalid", "Expired",
   * "Blocked", ...). Never rejects.
   *
   * The local decision comes first (see `auth/LocalAuthorizationResolver.ts`
   * for the rules and their OCPP 1.6 §3.5 / 2.0.1 C12-C15 sources):
   * - offline, it decides alone, at once, without Authorize.req;
   * - online, a valid local-list or cache entry with `LocalPreAuthorize`
   *   resolves "Accepted" without Authorize.req (§9.1.13);
   * - otherwise Authorize.req goes out and the tag-matched
   *   `authorizeResult` event resolves it, so concurrent Authorize calls
   *   for different tags don't cross streams.
   *
   * While waiting, a disconnect hands the decision to the offline rules.
   * A timeout while still connected falls back to what the station knows:
   * a NOT-valid local-list or cache entry resolves its status (#452);
   * anything else warns and resolves "Accepted" (warn-and-proceed, #181).
   * A timeout once the socket is gone applies the offline rules.
   *
   * On OCPP 2.x the CALL may wait behind another one (Part 4 §4.1.1, #708), so
   * the timeout is armed when the Authorize is written, not when it is queued
   * (#762), and lasts at least `MessageTimeout`. `failClosed` (2.x F01.FR.01,
   * 1.6 §5.11: a remote start only after authorization was obtained, #921)
   * makes an unanswered Authorize resolve "Unknown" instead of
   * warn-and-proceed "Accepted".
   */
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
