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
import { UploadFile } from "../fileUpload";
import { LogRepository } from "../persistence/LogRepository";
import { createDefaultTransport } from "./createDefaultTransport";

/**
 * The production dependencies shared by every charge point (#575). The log
 * sink is per charge point (it buffers and is closed on `dispose`), so
 * `createChargePoint` builds it from its `database` argument.
 */
const DEFAULT_DEPS: Omit<ChargePointDeps, "logSink"> = {
  createTransport: createDefaultTransport,
  fileUploader: UploadFile,
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
    // `database = null` keeps the repository a no-op (remote-mode browser).
    { ...DEFAULT_DEPS, logSink: new LogRepository(database) },
  );
}
