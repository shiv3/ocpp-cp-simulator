import {
  RpcFailure,
  type RpcErrorCode,
} from "@ocpp-cp-simulator/contracts/index";
import {
  VehicleCatalogError,
  type VehicleCatalogErrorKind,
} from "@ocpp-cp-simulator/core/cp/domain/vehicle/VehicleCatalog";

/**
 * #458: a failed `vehicle_catalog.*` call as the catalog port's error, so the
 * console handles Local and Remote failures alike. The daemon's message is
 * kept; it never contains the key.
 */
export function toVehicleCatalogError(error: unknown): VehicleCatalogError {
  if (!(error instanceof RpcFailure)) {
    return new VehicleCatalogError(
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }
  return new VehicleCatalogError(catalogKindOf(error.code), error.message, {
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

/** The reverse of the daemon's mapping in `apps/cli/src/server/vehicleRpc.ts`. */
function catalogKindOf(code: RpcErrorCode): VehicleCatalogErrorKind {
  switch (code) {
    case "unauthorized":
    case "not_found":
    case "rate_limited":
    case "timeout":
    case "unavailable":
      return code;
    case "invalid_params":
      return "invalid_request";
    case "disconnected":
      return "network";
    default:
      return "unavailable";
  }
}

export function publicFailure(code: RpcErrorCode): RpcFailure {
  switch (code) {
    case "timeout":
      return new RpcFailure(code, "rpc timed out");
    case "disconnected":
      return new RpcFailure(code, "disconnected");
    default:
      return new RpcFailure(code, code.replace(/_/g, " "));
  }
}
