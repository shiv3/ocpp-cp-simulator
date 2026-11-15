import { createChargePoint } from "@ocpp-cp-simulator/core/cp/infrastructure/charge-point/createChargePoint";
import type {
  AutoMeterValueSetting,
  ChargePoint,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type { BootNotification } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import {
  BROWSER_TLS_UNSUPPORTED_MESSAGE,
  UnsupportedFeatureError,
} from "@ocpp-cp-simulator/client/interfaces/UnsupportedFeatureError";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";

export interface LocalChargePointDefinition {
  id: string;
  connectorNumber: number;
  bootNotification: BootNotification;
  wsUrl: string;
  centralSystemUrl?: string;
  soapCallbackUrl?: string;
  soapPath?: string;
  basicAuth: { username: string; password: string } | null;
  autoMeterValueSetting: AutoMeterValueSetting | null;
  ocppVersion?: string;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  cpoName?: string;
  /** #347: see ChargePoint.txUpdatedMeterValues. Absent means on (#551). */
  txUpdatedMeterValues?: boolean;
  tls?: OcppTlsOptions;
}

export function assertBrowserLocalTlsSupported(
  definition: LocalChargePointDefinition,
): void {
  const profile = definition.securityProfile ?? 0;
  const hasTlsMaterial = Boolean(
    definition.tls?.ca || definition.tls?.cert || definition.tls?.key,
  );
  if (profile === 2 || profile === 3 || hasTlsMaterial) {
    throw new UnsupportedFeatureError(
      "browser_tls_unsupported",
      BROWSER_TLS_UNSUPPORTED_MESSAGE,
    );
  }
}

export function buildChargePoint(
  database: Database | null,
  definition: LocalChargePointDefinition,
): ChargePoint {
  assertBrowserLocalTlsSupported(definition);
  const chargePoint = createChargePoint(
    definition.id,
    definition.bootNotification,
    definition.connectorNumber,
    definition.wsUrl,
    definition.basicAuth,
    definition.autoMeterValueSetting,
    database,
    {},
    [],
    definition.ocppVersion,
    {
      centralSystemUrl: definition.centralSystemUrl,
      soapCallbackUrl: definition.soapCallbackUrl,
      soapPath: definition.soapPath,
    },
    definition.securityProfile,
    definition.authorizationKey,
    definition.cpoName,
    definition.tls,
  );
  chargePoint.txUpdatedMeterValues = definition.txUpdatedMeterValues !== false;

  // Restore connector-level settings from the SQLite store. Sync reads
  // are safe because both adapters expose `Database.get/all`
  // synchronously; we're inside the per-CP construction path that runs
  // once per registration.
  if (database) {
    for (
      let connectorId = 1;
      connectorId <= definition.connectorNumber;
      connectorId++
    ) {
      const autoMeterRow = database.get<{ auto_meter: string | null }>(
        "SELECT auto_meter FROM connector_settings " +
          "WHERE cp_id = ? AND connector_id = ?",
        [definition.id, connectorId],
      );
      if (autoMeterRow?.auto_meter) {
        try {
          const connector = chargePoint.getConnector(connectorId);
          if (connector) {
            connector.autoMeterValueConfig = JSON.parse(
              autoMeterRow.auto_meter,
            ) as AutoMeterValueConfig;
          }
        } catch {
          // Corrupted JSON in the row — fall back to defaults.
        }
      }

      const profileRows = database.all<{ profile: string }>(
        "SELECT profile FROM charging_profiles " +
          "WHERE cp_id = ? AND connector_id = ? ORDER BY stack_level DESC",
        [definition.id, connectorId],
      );
      const profiles = profileRows
        .map((r) => {
          try {
            return JSON.parse(r.profile) as ActiveChargingProfile;
          } catch {
            return null;
          }
        })
        .filter((p): p is ActiveChargingProfile => p !== null);
      if (profiles.length > 0) {
        const connector = chargePoint.getConnector(connectorId);
        connector?.setChargingProfiles(profiles);
      }
    }
  }

  return chargePoint;
}
