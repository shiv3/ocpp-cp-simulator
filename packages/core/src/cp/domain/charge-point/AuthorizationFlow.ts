import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock, TimerHandle } from "../../shared/clock";
import type { LocalOnlyDecision } from "../auth/LocalAuthorizationResolver";
import type { StationAuthorization } from "../auth/StationAuthorization";
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
    | "updateConnectorStatus"
  >;
  readonly authorization: () => StationAuthorization;
  readonly clock: () => SimClock;
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
  constructor(private readonly host: AuthorizationFlowHost) {}

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
