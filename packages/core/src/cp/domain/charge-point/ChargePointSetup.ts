import type { SimClock } from "../../shared/clock";
import { AuthorizationCache } from "../auth/AuthorizationCache";
import { idTokenMaxLength } from "../auth/AuthorizationCacheSeed";
import type { LocalAuthListManager } from "../auth/LocalAuthList";
import { StationAuthorization } from "../auth/StationAuthorization";
import type { ChargePointRepositories } from "../persistence/ChargePointRepositories";
import { OCPPStatus } from "../types/OcppTypes";
import { isOcpp2Version } from "../types/OcppVersion";
import type {
  ChargePointCollaborators,
  StationContext,
} from "./ChargePointCollaborators";
import type { PowerSharingConfig } from "./PowerSharing";
import type { ConfigurationStore } from "./ConfigurationStore";

/**
 * The station's local authorization (#452). The policy is read on every
 * decision, so ChangeConfiguration applies at once: `configuration` is
 * assigned late in the charge point constructor and nothing reads the policy
 * before the constructor returns.
 */
export function createStationAuthorization(options: {
  readonly clock: SimClock;
  readonly configuration: () => ConfigurationStore;
  readonly localList: LocalAuthListManager;
  readonly ocppVersion: string;
  readonly repositories: ChargePointRepositories;
}): StationAuthorization {
  const configuration = options.configuration;
  return new StationAuthorization({
    cache: new AuthorizationCache(options.repositories.authorizationCache, {
      clock: options.clock,
    }),
    localList: options.localList,
    policy: () => ({
      cacheEnabled: configuration().authorizationCacheEnabled(),
      localListEnabled: configuration().localAuthListEnabled(),
      localPreAuthorize: configuration().localPreAuthorize(),
      localAuthorizeOffline: configuration().localAuthorizeOffline(),
      allowOfflineTxForUnknownId: configuration().allowOfflineTxForUnknownId(),
      // 2.x AuthCacheCtrlr.LifeTime; a 1.6 store has no such key → null.
      cacheLifetimeSeconds: configuration().authCacheLifeTimeSeconds(),
      localListChecksExpiry: true,
    }),
    idTokenMaxLength: idTokenMaxLength(options.ocppVersion),
    clock: options.clock,
  });
}

/**
 * The end of the charge point constructor, once the configuration store
 * exists: the construction-time options are applied to it and the listeners
 * that tie it to the rest of the station are wired, in this order.
 */
export function completeConstruction(
  parts: ChargePointCollaborators,
  ctx: StationContext,
  options: {
    readonly securityProfile: number | undefined;
    readonly authorizationKey: string | undefined;
    readonly cpoName: string | undefined;
    readonly powerSharing: PowerSharingConfig | undefined;
  },
): void {
  const configuration = ctx.configuration();
  if (options.securityProfile !== undefined) {
    configuration.applyChange(
      "SecurityProfile",
      String(options.securityProfile),
    );
  }
  if (options.authorizationKey !== undefined) {
    configuration.applyChange("AuthorizationKey", options.authorizationKey);
  }
  if (options.cpoName !== undefined) {
    configuration.applyChange("CpoName", options.cpoName);
  }
  parts.configWiring.wireConfigurationListeners();
  parts.configWiring.wirePowerSharing(options.powerSharing);
  const ocpp2 = isOcpp2Version(ctx.ocppVersion());
  if (ocpp2) {
    // 2.x: only the BasicAuthPassword (AuthorizationKey) guard; the
    // SecurityProfile prerequisites are the 1.6 ChangeConfiguration's (#704).
    parts.configWiring.wireAuthorizationKeyGuard();
  } else if (ctx.webSocket()) {
    parts.configWiring.wireSecurityConfiguration();
  }
  // §5.2: a CP-level Unavailable set previously must survive a reboot.
  // We don't actually transition status here (no WebSocket yet); the
  // saved flag is reapplied when ChangeAvailability runs or when the
  // operator inspects the persisted state. Read before the 2.x runtime
  // values are first published, so ChargingStation.AvailabilityState
  // starts from it (#538).
  const persistedCp = ctx.loadAvailability(0);
  if (persistedCp === "Inoperative") {
    ctx.setStatus(OCPPStatus.Unavailable);
  }
  if (ocpp2) {
    parts.deviceModel.wireVariableMonitoring();
    parts.configWiring.wireCertificateEntries();
    parts.configWiring.wireClockAndLocalList();
    parts.certSwitch.watchClientIdentity();
  }
  // A persisted override never fires onChange; the scheduler only runs
  // once a boot is Accepted (#454).
  ctx
    .clockAligned()
    .setIntervalSeconds(configuration.clockAlignedDataInterval());
  if (ocpp2) {
    parts.configWiring.applyRetryBackOff();
    ctx
      .txEndedAligned()
      .setIntervalSeconds(configuration.alignedDataTxEndedInterval());
  }
  // A value persisted with --state-db is in force from the first open.
  ctx.webSocket()?.setPingInterval(configuration.webSocketPingInterval());
  // #930: a suspended SIM on a cellular station keeps the link down from
  // the very first connect, also after a restart.
  ctx.cellular().reevaluateCellularLink();
}
