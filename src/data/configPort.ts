import type { SimulatorConfigInput, WireSimulatorConfig } from "../protocol";
import type { Config } from "../store/store";

export function getConfigBasicAuthPassword(
  config: WireSimulatorConfig | SimulatorConfigInput | null,
): string {
  if (!config) return "";
  const settings = config.basicAuthSettings as { password?: unknown };
  return typeof settings.password === "string" ? settings.password : "";
}

export function mergeWriteOnlyConfigSecrets(
  next: SimulatorConfigInput | null,
  existing: Config | null,
): Config | null {
  if (next === null) return null;

  const suppliedPassword = next.basicAuthSettings.password;
  const password =
    typeof suppliedPassword === "string" && suppliedPassword.length > 0
      ? suppliedPassword
      : (existing?.basicAuthSettings.password ?? "");

  return {
    wsURL: next.wsURL,
    ChargePointID: next.ChargePointID,
    connectorNumber: next.connectorNumber,
    tagID: next.tagID,
    ocppVersion: next.ocppVersion,
    basicAuthSettings: {
      enabled: next.basicAuthSettings.enabled,
      username: next.basicAuthSettings.username,
      password,
    },
    autoMeterValueSetting: {
      enabled: next.autoMeterValueSetting.enabled,
      interval: next.autoMeterValueSetting.interval,
      value: next.autoMeterValueSetting.value,
    },
    Experimental: next.Experimental
      ? {
          ChargePointIDs: next.Experimental.ChargePointIDs.map((cp) => ({
            ChargePointID: cp.ChargePointID,
            ConnectorNumber: cp.ConnectorNumber,
          })),
          TagIDs: [...next.Experimental.TagIDs],
        }
      : null,
    BootNotification: next.BootNotification
      ? { ...next.BootNotification }
      : null,
  };
}
