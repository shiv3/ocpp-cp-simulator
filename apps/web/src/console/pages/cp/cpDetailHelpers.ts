import { getConfigBasicAuthPassword } from "@ocpp-cp-simulator/client/configPort";
import {
  defaultChargePointConfig,
  type ChargePointConfig,
} from "@/components/chargePointConfig";
import type { MessageKey } from "@/i18n";
import type { ChargePointSnapshot } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type { WireSimulatorConfig } from "@ocpp-cp-simulator/contracts/index";

/** What the lower half shows (`?tab=`); `log` is the default and has no param. */
export type Section =
  | "log"
  | "transactions"
  | "events"
  | "analysis"
  | "diagnostics"
  | "configuration"
  | "expert"
  | "network";

/** The lower half's tabs, in order; `log` is the default. */
export const SECTIONS: ReadonlyArray<{ value: Section; labelKey: MessageKey }> =
  [
    { value: "log", labelKey: "cp.section.log" },
    { value: "transactions", labelKey: "cp.section.transactions" },
    { value: "events", labelKey: "cp.section.events" },
    { value: "analysis", labelKey: "cp.section.analysis" },
    { value: "diagnostics", labelKey: "cp.section.diagnostics" },
    { value: "configuration", labelKey: "cp.section.configuration" },
    { value: "expert", labelKey: "cp.section.expert" },
    { value: "network", labelKey: "cp.section.network" },
  ];

export function isSection(
  value: string | null,
): value is Exclude<Section, "log"> {
  return value !== "log" && SECTIONS.some((section) => section.value === value);
}

/**
 * Builds the `ChargePointConfig` shape `ChargePointConfigForm` expects,
 * from whichever source currently holds this CP's settings — remote mode's
 * `ChargePointSnapshot.config` (daemon-owned, echoed back from the CP's
 * creation params) or local mode's single shared `useConfig()` result
 * (browser-owned, one config for every local CP). Kept private (not exported)
 * so this file's only runtime export stays the default component.
 */
export function buildChargePointConfig(
  cpId: string,
  cp: ChargePointSnapshot | undefined,
  mode: "local" | "remote",
  localConfig: WireSimulatorConfig | null,
): ChargePointConfig {
  if (mode === "remote") {
    const c = cp?.config;
    const bn = c?.bootNotification ?? null;
    return {
      ...defaultChargePointConfig,
      cpId: cp?.id ?? cpId,
      connectorNumber:
        c?.connectors ??
        cp?.connectors.length ??
        defaultChargePointConfig.connectorNumber,
      wsURL: c?.wsUrl ?? defaultChargePointConfig.wsURL,
      ocppVersion: c?.ocppVersion ?? defaultChargePointConfig.ocppVersion,
      basicAuthEnabled: !!c?.basicAuth,
      basicAuthUsername: c?.basicAuth?.username ?? "",
      basicAuthPassword: c?.basicAuth?.password ?? "",
      securityProfile: c?.securityProfile,
      soapCallbackUrl: c?.soapCallbackUrl,
      soapCallbackUrlDerived: c?.soapCallbackUrlDerived,
      soapPath: c?.soapPath,
      cpoName: c?.cpoName,
      txUpdatedMeterValues: c?.txUpdatedMeterValues,
      tlsCaPath: c?.tlsCaPath,
      tlsCertPath: c?.tlsCertPath,
      tlsKeyPath: c?.tlsKeyPath,
      chargePointVendor:
        c?.vendor ?? defaultChargePointConfig.chargePointVendor,
      chargePointModel: c?.model ?? defaultChargePointConfig.chargePointModel,
      firmwareVersion:
        bn?.firmwareVersion ?? defaultChargePointConfig.firmwareVersion,
      chargeBoxSerialNumber: bn?.chargeBoxSerialNumber ?? "",
      chargePointSerialNumber: bn?.chargePointSerialNumber ?? "",
      meterSerialNumber: bn?.meterSerialNumber ?? "",
      meterType: bn?.meterType ?? "",
      iccid: bn?.iccid ?? "",
      imsi: bn?.imsi ?? "",
      // No `labels` (#471): the header's Labels card owns them, and leaving
      // them out of cp.update keeps the daemon's.
    };
  }

  if (!localConfig) {
    return { ...defaultChargePointConfig, cpId };
  }

  const connectorNumber =
    localConfig.Experimental?.ChargePointIDs.find(
      (entry) => entry.ChargePointID === cpId,
    )?.ConnectorNumber ?? localConfig.connectorNumber;

  return {
    ...defaultChargePointConfig,
    cpId,
    connectorNumber,
    wsURL: localConfig.wsURL,
    ocppVersion: localConfig.ocppVersion,
    txUpdatedMeterValues: localConfig.txUpdatedMeterValues,
    basicAuthEnabled: localConfig.basicAuthSettings.enabled,
    basicAuthUsername: localConfig.basicAuthSettings.username,
    basicAuthPassword: getConfigBasicAuthPassword(localConfig),
    autoMeterValueEnabled: localConfig.autoMeterValueSetting.enabled,
    autoMeterValueInterval: localConfig.autoMeterValueSetting.interval,
    autoMeterValue: localConfig.autoMeterValueSetting.value,
    chargePointVendor:
      localConfig.BootNotification?.chargePointVendor ??
      defaultChargePointConfig.chargePointVendor,
    chargePointModel:
      localConfig.BootNotification?.chargePointModel ??
      defaultChargePointConfig.chargePointModel,
    firmwareVersion:
      localConfig.BootNotification?.firmwareVersion ??
      defaultChargePointConfig.firmwareVersion,
    chargeBoxSerialNumber:
      localConfig.BootNotification?.chargeBoxSerialNumber ?? "",
    chargePointSerialNumber:
      localConfig.BootNotification?.chargePointSerialNumber ?? "",
    meterSerialNumber: localConfig.BootNotification?.meterSerialNumber ?? "",
    meterType: localConfig.BootNotification?.meterType ?? "",
    iccid: localConfig.BootNotification?.iccid ?? "",
    imsi: localConfig.BootNotification?.imsi ?? "",
  };
}
