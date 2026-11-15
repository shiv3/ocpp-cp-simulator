import type {
  OcppTlsOptions,
  classifyBasicAuthSource,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import type { ChargePointConfig, SoapPublicBase } from "./chargePointConfig";

export interface ConfigFormState {
  config: ChargePointConfig;
  mode: "local" | "remote";
  isNewChargePoint: boolean;
  soapPublicBase: SoapPublicBase | null;
  derivedSoapCallbackUrl: string | null | undefined;
  soapCallbackOptional: boolean;
  soapCallbackHelp: string;
  updateConfig: (
    key: keyof ChargePointConfig,
    value: ChargePointConfig[keyof ChargePointConfig],
  ) => void;
  changeProtocol: (value: string) => void;
  changeOcppVersion: (value: string) => void;
  changeSecurityProfile: (value: string) => void;
  updateTls: (patch: Partial<OcppTlsOptions>) => void;
  composedFullUrl: string;
  typedSoapCallbackUrl: string | undefined;
  effectiveSoapCallbackUrl: string | null;
  securityProfile: number;
  basicAuthSource: ReturnType<typeof classifyBasicAuthSource>;
}

export function withoutDerivedSoapCallbackUrl(
  config: ChargePointConfig,
): ChargePointConfig {
  return config.soapCallbackUrlDerived
    ? { ...config, soapCallbackUrl: "" }
    : config;
}
