import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import {
  ChargePoint,
  type AutoMeterValueSetting,
  type BasicAuthSettings,
  type ChargePointSimulationOptions,
  type ChargePointTransportOptions,
} from "../../domain/charge-point/ChargePoint";
import type { ChargePointDeps } from "../../domain/charge-point/ChargePointDeps";
import type { Database } from "../../domain/persistence/Database";
import type { BootNotification } from "../../domain/types/OcppTypes";
import type { OcppTlsOptions } from "../../domain/transport/ConnectionSecurity";
import { createDefaultTransport } from "./createDefaultTransport";

/** The production dependencies of every charge point (#575). */
const DEFAULT_DEPS: ChargePointDeps = {
  createTransport: createDefaultTransport,
};

/**
 * Composition root for a {@link ChargePoint}: the single place that calls its
 * constructor. Every caller (CLI, web console, tests, benches) builds charge
 * points through here so infrastructure dependencies are injected in one
 * spot (#575). The parameters are the constructor's, in the same order and
 * with the same defaults, without the final `deps`.
 */
export function createChargePoint(
  id: string,
  bootNotification: BootNotification,
  connectorCount: number,
  wsUrl: string,
  basicAuthSettings: BasicAuthSettings | null,
  autoMeterValueSetting: AutoMeterValueSetting | null,
  database: Database | null = null,
  extraWsHeaders: Record<string, string> = {},
  extraWsSubprotocols: ReadonlyArray<string> = [],
  ocppVersion: string = "OCPP-1.6J",
  transportOptions: ChargePointTransportOptions = {},
  securityProfile?: OcppSecurityProfile,
  authorizationKey?: string,
  cpoName?: string,
  tls?: OcppTlsOptions,
  simulation: ChargePointSimulationOptions = {},
): ChargePoint {
  return new ChargePoint(
    id,
    bootNotification,
    connectorCount,
    wsUrl,
    basicAuthSettings,
    autoMeterValueSetting,
    database,
    extraWsHeaders,
    extraWsSubprotocols,
    ocppVersion,
    transportOptions,
    securityProfile,
    authorizationKey,
    cpoName,
    tls,
    simulation,
    DEFAULT_DEPS,
  );
}
