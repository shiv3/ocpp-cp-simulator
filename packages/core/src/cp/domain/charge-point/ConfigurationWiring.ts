import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import { LogType, type Logger } from "../../shared/Logger";
import type { Connector } from "../connector/Connector";
import type { LocalAuthListManager } from "../auth/LocalAuthList";
import type { CertificateStore } from "../security/CertificateStore";
import {
  checkNetworkProfile,
  type NetworkConnectionProfile,
  type NetworkProfileStore,
  type NetworkProfileVerdict,
} from "../security/networkProfiles";
import {
  checkSecurityProfileChange,
  isCertificateCurrentlyValid,
  isValidAuthorizationKey,
  isValidBasicAuthPassword,
} from "../security/securityProfileChange";
import type { ChargePointHeartbeat } from "../services/ChargePointHeartbeat";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import { isOcpp2Version } from "../types/OcppVersion";
import type { ChargePoint } from "./ChargePoint";
import type { ClockAlignedMeterScheduler } from "./ClockAlignedMeterScheduler";
import type { ConfigurationStore } from "./ConfigurationStore";
import {
  connectorShareW,
  stationBudgetW,
  type PowerSharingConfig,
  type ShareParticipant,
} from "./PowerSharing";
import { RUNTIME_VALUE_KEYS } from "./runtimeValueKeys";

/** What the configuration wiring needs from its charge point. Members are
 *  read through functions: the fields behind them are assigned after the
 *  wiring is constructed or are reassigned later. */
export interface ConfigurationWiringHost {
  /** Public members are called through it so spies on the charge point
   *  still see them. */
  readonly chargePoint: () => Pick<ChargePoint, "reset">;
  readonly certificateStore: () => CertificateStore;
  readonly clockAligned: () => ClockAlignedMeterScheduler;
  readonly configuration: () => ConfigurationStore;
  readonly connectors: () => Map<number, Connector>;
  readonly heartbeat: () => ChargePointHeartbeat;
  readonly localAuthListManager: () => LocalAuthListManager;
  readonly logger: () => Logger;
  readonly networkProfiles: () => NetworkProfileStore;
  readonly nowDate: () => Date;
  readonly ocppVersion: () => string;
  readonly rearmPeriodicSampling: () => void;
  readonly txEndedAligned: () => ClockAlignedMeterScheduler;
  readonly webSocket: () => ChargePointSocket | null;
}

/**
 * The listeners that tie live configuration values to the rest of the
 * station: clock and local list keys, certificate entries, security
 * credential and profile guards, power sharing and the interval keys.
 * Owns the power sharing config; the charge point keeps the public methods
 * as thin delegates.
 */
export class ConfigurationWiring {
  private _powerSharing: PowerSharingConfig | undefined;

  constructor(private readonly host: ConfigurationWiringHost) {}

  /**
   * B09 SetNetworkProfile: validate `profile` against the station
   * (`checkNetworkProfile`) and, when valid, store it in
   * `configurationSlot`. The connection is left as it is: the stored profile
   * is used only by a later Reset or NetworkConfigurationPriority change.
   */
  setNetworkProfile(
    configurationSlot: number,
    profile: NetworkConnectionProfile,
  ): NetworkProfileVerdict {
    const verdict = checkNetworkProfile({
      configurationSlot,
      profile,
      currentSecurityProfile:
        this.host.configuration().getInteger("SecurityProfile") ?? 0,
      allowSecurityProfileDowngrade: this.host
        .configuration()
        .allowSecurityProfileDowngrade(),
    });
    if (verdict.accepted) {
      this.host.networkProfiles().set(configurationSlot, profile);
      this.host
        .logger()
        .info(
          `SetNetworkProfile: stored a profile in slot ${configurationSlot} (security profile ${profile.securityProfile}); the connection is unchanged`,
          LogType.CONFIGURATION,
        );
    } else {
      this.host
        .logger()
        .warn(
          `SetNetworkProfile slot ${configurationSlot} rejected (${verdict.reasonCode}): ${verdict.additionalInfo}`,
          LogType.CONFIGURATION,
        );
    }
    return verdict;
  }

  /**
   * #704: 2.x `ClockCtrlr.DateTime` reads the station clock on every read;
   * `LocalAuthListCtrlr.Entries` follows the local list.
   */
  wireClockAndLocalList(): void {
    this.host
      .configuration()
      .defineLiveKey(RUNTIME_VALUE_KEYS.clockDateTime, () =>
        this.host.nowDate().toISOString(),
      );
    const key = RUNTIME_VALUE_KEYS.localAuthListEntries;
    this.host.configuration().defineRuntimeIntegerKey(key, 0, { min: 0 });
    this.host.localAuthListManager().onChange((entries) => {
      this.host.configuration().setRuntimeValue(key, entries);
    });
  }

  /**
   * #537: 2.x `SecurityCtrlr.CertificateEntries` is the number of installed
   * trust anchors, the set M05.FR.06 limits. The certificate store stays
   * the source; the configuration value follows it, so GetVariables,
   * GetBaseReport and variable monitors read it like any other variable,
   * and a change fires the configuration listeners monitors evaluate on.
   */
  wireCertificateEntries(): void {
    const sync = (): void => {
      this.host
        .configuration()
        .setRuntimeValue(
          "CertificateEntries",
          this.host.certificateStore().listRootCertificates().length,
        );
    };
    sync();
    this.host.certificateStore().onChange(sync);
  }

  /**
   * #724 (1.6 security whitepaper A01, A05): the transport sends the
   * stored `AuthorizationKey` and `SecurityProfile` from the next attempt
   * on, and a `SecurityProfile` change is checked against the A05
   * prerequisites. Installed after the constructor applied its own initial
   * values, which are not ChangeConfiguration requests.
   */
  wireSecurityConfiguration(): void {
    this.wireAuthorizationKeyGuard();
    this.wireSecurityProfileGuard();
  }

  wireAuthorizationKeyGuard(): void {
    // §7.2: with profile 1 or 2 the key is the Basic Auth password; one the
    // transport cannot derive it from (an empty value or one of another length) would stop
    // every later connection attempt, so it is refused and the old key kept.
    this.host
      .configuration()
      .setChangeGuard("AuthorizationKey", (_current, next) => {
        const profile =
          this.host.configuration().getInteger("SecurityProfile") ?? 0;
        if (
          (profile !== 1 && profile !== 2) ||
          (isOcpp2Version(this.host.ocppVersion())
            ? isValidBasicAuthPassword(`${next}`)
            : isValidAuthorizationKey(`${next}`))
        ) {
          return true;
        }
        this.host
          .logger()
          .warn(
            `ChangeConfiguration AuthorizationKey refused: security profile ${profile} needs ${
              isOcpp2Version(this.host.ocppVersion())
                ? "a BasicAuthPassword of 16-40 printable characters (A00.FR.202)"
                : "a key of 16-20 bytes (32-40 hex digits, or 16-20 plain characters), whitepaper §7.2"
            }`,
            LogType.CONFIGURATION,
          );
        return false;
      });
  }

  private wireSecurityProfileGuard(): void {
    this.host
      .configuration()
      .setChangeGuard("SecurityProfile", (current, next) => {
        const now = this.host.nowDate();
        const verdict = checkSecurityProfileChange({
          current: typeof current === "number" ? current : 0,
          next: typeof next === "number" ? next : 0,
          authorizationKey:
            this.host.configuration().getString("AuthorizationKey") ?? "",
          // Only what the TLS connection validates the CSMS with: roots that
          // InstallCertificate stored do not join its trust, so counting them
          // would accept an upgrade that cannot connect.
          hasCentralSystemRoot:
            this.host.webSocket()?.hasConfiguredTrustAnchors() ?? false,
          hasChargePointCertificate:
            this.host
              .certificateStore()
              .listSignedChains("ChargingStationCertificate")
              .some((chain) =>
                isCertificateCurrentlyValid(chain.pems[0], now),
              ) ||
            (this.host.webSocket()?.hasClientCertificate() ?? false),
        });
        if (!verdict.allowed) {
          this.host
            .logger()
            .warn(
              `ChangeConfiguration SecurityProfile=${next} refused (${verdict.requirement}): ${verdict.reason}`,
              LogType.CONFIGURATION,
            );
        }
        return verdict.allowed;
      });
    this.host.configuration().onChange((key, value) => {
      if (key === "AuthorizationKey" && typeof value === "string") {
        this.host
          .webSocket()
          ?.setSecurityCredentials({ authorizationKey: value });
      } else if (key === "SecurityProfile" && typeof value === "number") {
        this.host.webSocket()?.setSecurityCredentials({
          securityProfile: value as OcppSecurityProfile,
        });
      }
    });
  }

  /**
   * #724 A05.FR.06-08: after the CALLRESULT of an accepted `SecurityProfile`
   * upgrade the station disconnects and reconnects with the new profile.
   * When that connection does not open, the previous profile is put back
   * and used for the next attempt (A05.FR.08).
   */
  switchSecurityProfile(previousProfile: number): void {
    this.host.webSocket()?.armSecurityProfileFallback(() => {
      this.host
        .logger()
        .warn(
          `Could not connect with security profile ${this.host.configuration().getInteger("SecurityProfile")}; falling back to profile ${previousProfile} (A05.FR.08)`,
          LogType.CONFIGURATION,
        );
      this.host
        .configuration()
        .applyChange("SecurityProfile", String(previousProfile), {
          bypassGuard: true,
        });
    });
    this.host
      .logger()
      .info(
        "SecurityProfile changed: reconnecting with the new profile (A05.FR.06/07)",
        LogType.CONFIGURATION,
      );
    this.host.chargePoint().reset();
  }

  /**
   * Let the connectors share the station's power budget (#608). The share is
   * read at every operating point resolve from the connectors' transactions
   * at that instant, so a transaction that starts or stops moves it with no
   * bookkeeping. A declared current limit key becomes a writable configuration
   * key; it is read here at resolve time too, so `ChangeConfiguration`
   * changes the budget at once.
   */
  wirePowerSharing(config: PowerSharingConfig | undefined): void {
    if (!config) return;
    this._powerSharing = config;
    const limit = config.currentLimit;
    if (limit) {
      const declared = this.host
        .configuration()
        .defineWritableIntegerKey(limit.key, Math.round(limit.valueA), {
          min: 1,
        });
      if (!declared) {
        this.host
          .logger()
          .warn(
            `powerSharing.currentLimit.key ${limit.key} is already a configuration key; the declared limit is ignored`,
            LogType.CONFIGURATION,
          );
      }
    }
    const strategy = config.strategy ?? "equal";
    for (const [connectorId, connector] of this.host.connectors()) {
      connector.setStationShareProvider(() => {
        const participants: ShareParticipant[] = [];
        for (const [id, c] of this.host.connectors()) {
          participants.push({
            connectorId: id,
            capW: c.maxDeliveryPowerW ?? Infinity,
            active: c.hasRunningTransaction,
          });
        }
        return connectorShareW(
          this.stationPowerBudgetW(),
          strategy,
          participants,
          connectorId,
        );
      });
    }
  }

  /** The station's power budget in watts now, `Infinity` without sharing. */
  stationPowerBudgetW(): number {
    const limit = this._powerSharing?.currentLimit;
    return stationBudgetW(
      this._powerSharing,
      limit ? this.host.configuration().getInteger(limit.key) : undefined,
    );
  }

  /** Hook up subsystems that react to live Configuration changes. */
  /** #609: hand the 2.x `RetryBackOff*` variables to the transport. */
  applyRetryBackOff(): void {
    this.host.webSocket()?.setRetryBackOff({
      waitMinimumSeconds: this.host.configuration().retryBackOffWaitMinimum(),
      randomRangeSeconds: this.host.configuration().retryBackOffRandomRange(),
      repeatTimes: this.host.configuration().retryBackOffRepeatTimes(),
    });
  }

  wireConfigurationListeners(): void {
    this.host.configuration().onChange((key, value) => {
      switch (key) {
        case "HeartbeatInterval":
          if (typeof value === "number" && value > 0) {
            this.host.heartbeat().startHeartbeat(value);
          } else {
            this.host.heartbeat().stopHeartbeat();
          }
          break;
        case "MeterValueSampleInterval":
          // §3.16.1 / §9.1.19 ask for a sample "every MeterValueSampleInterval
          // seconds" and, at 0, for none: the samplers of the running
          // transactions are re-armed with the new value (#839, #722). 2.x
          // does not run them.
          this.host
            .logger()
            .info(
              `MeterValueSampleInterval=${String(value)}`,
              LogType.CONFIGURATION,
            );
          this.host.rearmPeriodicSampling();
          break;
        case "WebSocketPingInterval":
          // #406: re-arms the ping timer at once on an open socket.
          if (typeof value === "number") {
            this.host.webSocket()?.setPingInterval(value);
          }
          break;
        case "RetryBackOffWaitMinimum":
        case "RetryBackOffRandomRange":
        case "RetryBackOffRepeatTimes":
          // #609: applies from the next reconnect attempt.
          this.applyRetryBackOff();
          break;
        case "ClockAlignedDataInterval":
          // #454: takes effect at once on the new grid while boot is Accepted.
          if (typeof value === "number") {
            this.host.clockAligned().setIntervalSeconds(value);
          }
          this.host
            .logger()
            .info(
              `ClockAlignedDataInterval=${String(value)}${
                this.host.configuration().meterValuesAlignedData().length === 0
                  ? " (MeterValuesAlignedData is empty: nothing will be sent)"
                  : ""
              }`,
              LogType.CONFIGURATION,
            );
          break;
        case "AlignedDataTxEndedInterval":
          // #607: the grid of the 2.x transaction-end history.
          if (typeof value === "number") {
            this.host.txEndedAligned().setIntervalSeconds(value);
          }
          break;
        default:
          break;
      }
    });
  }
}
