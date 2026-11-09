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
import { createChargePointRepositories } from "../persistence/createChargePointRepositories";
import { DEFAULT_SERVICES } from "./createDefaultServices";
import { createDefaultTransport } from "./createDefaultTransport";

/**
 * The production dependencies shared by every charge point (#575). The log
 * sink (it buffers and is closed on `dispose`) and the repositories (#878)
 * are per charge point, so `createChargePoint` builds them from its `database`
 * argument.
 */
const DEFAULT_DEPS: Omit<ChargePointDeps, "logSink" | "repositories"> = {
  ...DEFAULT_SERVICES,
  createTransport: createDefaultTransport,
  fileUploader: UploadFile,
};

/**
 * Composition root for a {@link ChargePoint}: the CLI, the web console, the
 * tests and the benches build charge points through here, so infrastructure
 * dependencies are injected in one spot (#575). Only `ChargePoint.deps.test.ts`
 * calls the constructor directly, to inject test doubles. The parameters are
 * the constructor's, in the same order and with the same defaults, without the
 * final `deps`.
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
    // `database = null` keeps the repositories no-ops (remote-mode browser).
    {
      ...DEFAULT_DEPS,
      logSink: new LogRepository(database),
      repositories: createChargePointRepositories(id, database),
    },
  );
}
