// Device Model variable table (#604), split out of DeviceModelRegistry.ts
// (#877): SecurityCtrlr referenced-component variables and per-EVSE runtime values.
import type { DeviceModelVariableDef } from "./DeviceModelRegistry";
import {
  RUNTIME_VALUE_KEYS,
  V2_CONNECTOR_STATUSES,
} from "../charge-point/runtimeValueKeys";
import { persistent, runtime } from "./deviceModelVariableHelpers";

export const SECURITY_AND_EVSE_VARIABLES: readonly DeviceModelVariableDef[] = [
  // #537: 2.0.1 / 2.1 Part 2 referenced components §2.2.4, §2.2.7-§2.2.9.
  persistent("SecurityCtrlr", "CertificateEntries", "CertificateEntries", {
    sharedWith16: false,
    mutability: "ReadOnly",
    dataType: "integer",
    min: 0,
    default: 0,
  }),
  persistent(
    "SecurityCtrlr",
    "MaxCertificateChainSize",
    "MaxCertificateChainSize",
    {
      sharedWith16: false,
      mutability: "ReadOnly",
      dataType: "integer",
      min: 1,
      max: 10000,
      default: 10000,
    },
  ),
  persistent(
    "SecurityCtrlr",
    "CertSigningWaitMinimum",
    "CertSigningWaitMinimum",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 1,
      default: 60,
      effect: "Seconds to wait for CertificateSigned before resending.",
    },
  ),
  persistent(
    "SecurityCtrlr",
    "CertSigningRepeatTimes",
    "CertSigningRepeatTimes",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 0,
      default: 3,
      effect: "How many times SignCertificate is resent.",
    },
  ),
  // B09.FR.04: whether SetNetworkProfile may lower the security profile
  // (from 3 to 2 only). The switch itself happens later, not on the write.
  persistent(
    "SecurityCtrlr",
    "AllowSecurityProfileDowngrade",
    "AllowSecurityProfileDowngrade",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "boolean",
      default: false,
      effect:
        "SetNetworkProfile accepts a security profile 2 profile while 3 is in force.",
    },
  ),
  // #538: per-EVSE runtime values; `valueKey` is the prefix of the per-EVSE
  // key. `ChargePoint.topology` maps a domain connector to its EVSE (#628);
  // every EVSE has one connector, number 1, until multi-connector EVSEs
  // bring per-connector keys.
  runtime("EVSE", "Power", RUNTIME_VALUE_KEYS.evsePower, {
    dataType: "decimal",
    unit: "W",
  }),
  runtime("EVSE", "AvailabilityState", RUNTIME_VALUE_KEYS.evseState, {
    dataType: "OptionList",
    valuesList: V2_CONNECTOR_STATUSES,
  }),
  runtime("Connector", "AvailabilityState", RUNTIME_VALUE_KEYS.connectorState, {
    dataType: "OptionList",
    valuesList: V2_CONNECTOR_STATUSES,
  }),
];
