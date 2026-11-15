import { InvalidEvSettingsPatchError } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import {
  ConfigurationWriteRejectedError,
  UnknownConfigurationKeyError,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import { InvalidAuthorizationCacheSeedError } from "@ocpp-cp-simulator/core/cp/domain/auth/AuthorizationCacheSeed";
import { OcppSecurityProfileConfigError } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import { ScenarioRunStateError } from "@ocpp-cp-simulator/core/cp/domain/errors/ScenarioRunStateError";
import {
  OcppCallNoAnswerError,
  OcppCallRejectedError,
} from "@ocpp-cp-simulator/core/cp/domain/errors/OcppCallErrors";
import type { ChargePointSnapshot } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import { RpcFailure } from "@ocpp-cp-simulator/contracts/index";
import {
  BehaviorNotLoadableError,
  UnknownBehaviorError,
  BehaviorParamsError,
} from "../../behavior/BehaviorLibrary";
import type { RegistryChargePointService } from "../RegistryChargePointService";

/**
 * Where a request is aimed. `cpIdInParams` is read off the raw params because
 * the schema strips an undeclared `cpId`, and it is the only way to tell the
 * caller that theirs is in the wrong place (#286).
 */
export interface RpcTarget {
  readonly cpId: string | undefined;
  readonly cpIdInParams: boolean;
}

/**
 * The rule that decides which word a facade failure gets back (#286).
 *
 * Exported because it *is* the contract: `not_found` is a statement about the
 * registry, `connect_failed` about the CSMS, `internal` about this daemon, and
 * a test that re-implements the rule instead of calling it would keep passing
 * while the three drifted apart. Returns null when the error is not one this
 * rule classifies, leaving it to propagate.
 */
export function classifyFacadeError(err: unknown): RpcFailure | null {
  if (err instanceof RpcFailure) return err;
  // cp.create/cp.update reject bad security-profile config (missing
  // authorizationKey for profiles 1-2, missing client cert/key for profile 3)
  // eagerly via CPRegistry.prepareInit, before anything is mutated.
  if (err instanceof OcppSecurityProfileConfigError) {
    return new RpcFailure("invalid_params", err.message);
  }
  // An id in `behaviors` that names no loaded behavior; the message lists
  // the loaded ids.
  if (
    err instanceof UnknownBehaviorError ||
    err instanceof BehaviorParamsError ||
    err instanceof BehaviorNotLoadableError
  ) {
    return new RpcFailure("invalid_params", err.message);
  }
  // #458: a set_ev_settings patch that would remove a required field.
  if (err instanceof InvalidEvSettingsPatchError) {
    return new RpcFailure("invalid_params", err.message);
  }
  // #612: a configuration key the charge point does not have, and one it
  // has but will not take (read-only, or a value outside its type / bounds).
  if (err instanceof UnknownConfigurationKeyError) {
    return new RpcFailure("not_found", err.message);
  }
  if (err instanceof ConfigurationWriteRejectedError) {
    return new RpcFailure("invalid_params", err.message);
  }
  // #452: a cache seed refused before anything was written.
  if (err instanceof InvalidAuthorizationCacheSeedError) {
    return new RpcFailure("invalid_params", err.message);
  }
  if (!(err instanceof Error)) return null;
  if (err.message.includes("already exists")) {
    return new RpcFailure("invalid_params", "");
  }
  if (
    err.message.includes("cpId not found") ||
    err.message.includes("not registered in LocalChargePointService")
  ) {
    return new RpcFailure("not_found", "");
  }
  // #286: `connect` resolves when the socket opens and rejects on the first
  // close, so a CSMS that refuses the upgrade lands here. Nothing broke -- the
  // daemon opened a socket, the CSMS said no, and the reconnect loop is
  // already running -- so `internal` was the wrong word for it. The close code
  // and reason travel in the message.
  if (
    err.message.startsWith("Connection failed:") ||
    err.message.startsWith("Connection timeout")
  ) {
    return new RpcFailure("connect_failed", err.message);
  }
  // #240: a scenario control aimed at a scenario that cannot take it (unknown,
  // not running, not parked on a wait, …) is a caller error, not a daemon
  // fault. The message names only the scenario id.
  if (err instanceof ScenarioRunStateError) {
    return new RpcFailure("invalid_params", err.message);
  }
  // #389: an expert OCPP call refused before anything was written (SOAP
  // station, action the station does not send, schema-invalid payload
  // without skipValidation, boot gate) is a caller error; the message says
  // which. No answer is a timeout, or a disconnect when the CALL never
  // reached the wire or the socket closed first.
  if (err instanceof OcppCallRejectedError) {
    return new RpcFailure("invalid_params", err.message);
  }
  if (err instanceof OcppCallNoAnswerError) {
    return new RpcFailure(
      err.reason === "timeout" ? "timeout" : "disconnected",
      err.message,
    );
  }
  return null;
}

export async function runFacadeOperation<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof RpcFailure) throw err;
    // The config rejection is the one case worth a server-side line: it names
    // the missing field (never a secret) and an operator reading the daemon
    // log should see why a create was refused.
    if (err instanceof OcppSecurityProfileConfigError) {
      console.warn(`[server] rejected charge point config: ${err.message}`);
    }
    const classified = classifyFacadeError(err);
    if (classified) throw classified;
    throw err;
  }
}

/**
 * #286 — a missing `cpId` is `invalid_params`, not `not_found`.
 *
 * `not_found` is a statement about the registry: this charge point does not
 * exist. When the envelope simply carried `cpId` in the wrong place it does
 * exist, and the reader is sent hunting for a creation bug. The two shapes
 * are genuinely easy to mix up — `cp.create` takes `cpId` INSIDE `params`,
 * every CP-scoped method takes it as a SIBLING of `method` — so the message
 * names the confusion when the params object is where it ended up.
 */
export function requireFacadeCpId(target: RpcTarget): string {
  if (!target.cpId) throw missingCpId(target);
  return target.cpId;
}

function missingCpId(target: RpcTarget): RpcFailure {
  return new RpcFailure(
    "invalid_params",
    target.cpIdInParams
      ? 'missing cpId: it belongs beside "method", not inside "params"'
      : "missing cpId",
  );
}

export async function requireChargePointSnapshot(
  chargePointService: RegistryChargePointService,
  cpId: string,
): Promise<ChargePointSnapshot> {
  const snapshot = await runFacadeOperation(() =>
    chargePointService.getChargePoint(cpId),
  );
  if (!snapshot) throw new RpcFailure("not_found", "");
  return snapshot;
}
