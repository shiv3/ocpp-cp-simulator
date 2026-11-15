import { LogType, type Logger } from "../../shared/Logger";
import { translatesCsmsActionNames } from "../types/csmsActionNames";
import { OCPP_1_6 } from "../types/OcppVersion";
import {
  capabilityProfileConflicts,
  disabledActionErrorCode,
  isActionDisabled,
  isTriggerTargetSupported,
  type ChargePointCapabilityProfile,
  type DisabledActionErrorCode,
} from "./CapabilityProfile";
import type { ConfigurationStore } from "./ConfigurationStore";

/** What the capability gate needs from its charge point. */
export interface CapabilityGateHost {
  readonly configuration: () => ConfigurationStore;
  readonly logger: () => Logger;
  readonly ocppVersion: () => string;
}

/**
 * The questions a charge point asks its capability profile (#618): which
 * inbound actions and TriggerMessage targets it refuses, whether it enforces
 * the 1.6 status transition table, and where the profile contradicts the
 * `SupportedFeatureProfiles` key. The charge point keeps the public members
 * as thin delegates.
 */
export class CapabilityGate {
  constructor(
    readonly profile: ChargePointCapabilityProfile | undefined,
    private readonly host: CapabilityGateHost,
  ) {}

  /** Is the inbound `action` disabled by the capability profile (#618)? */
  isActionDisabled(action: string): boolean {
    return isActionDisabled(
      this.profile,
      action,
      translatesCsmsActionNames(this.host.ocppVersion()),
    );
  }

  /** The CALLERROR code a disabled action is answered with (#618). */
  disabledActionErrorCode(): DisabledActionErrorCode {
    return disabledActionErrorCode(this.profile);
  }

  /**
   * Does this station keep a connector status change the OCPP 1.6 §4.9 table
   * does not list off the wire (`statusTransitions: "enforce"`, #618)? OCPP
   * 1.6J only: the table is written in the 1.6 status vocabulary, which 2.x
   * reports through a different ConnectorStatusEnumType with no such table.
   */
  get enforcesStatusTransitions(): boolean {
    return (
      this.profile?.statusTransitions === "enforce" &&
      this.host.ocppVersion() === OCPP_1_6
    );
  }

  /**
   * Log every place the capability profile contradicts the 1.6
   * `SupportedFeatureProfiles` configuration key (#618). Advisory: nothing
   * is refused.
   */
  warnConflicts(): void {
    if (this.host.ocppVersion() !== OCPP_1_6 || !this.profile) return;
    const conflicts = capabilityProfileConflicts(
      this.profile,
      this.host.configuration()?.getArray("SupportedFeatureProfiles"),
    );
    for (const conflict of conflicts) {
      this.host.logger().warn(conflict.message, LogType.SYSTEM);
    }
  }

  /** May TriggerMessage request `target` under the capability profile (#618)? */
  isTriggerTargetSupported(target: string): boolean {
    return isTriggerTargetSupported(
      this.profile,
      target,
      translatesCsmsActionNames(this.host.ocppVersion()),
    );
  }
}
