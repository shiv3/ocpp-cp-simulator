import {
  VehicleProfileLimitError,
  type VehicleProfileRepository,
} from "../../cp/domain/persistence/VehicleProfileRepository";
import {
  VehicleCatalogError,
  type VehicleCatalog,
} from "../../cp/domain/vehicle/VehicleCatalog";
import { RpcFailure, type Params, type RpcErrorCode } from "../../protocol";

/**
 * The daemon side of `vehicle_profiles.*` and `vehicle_catalog.*` (#458).
 *
 * The catalog is called here, with the key the daemon was started with, so a
 * console in Remote mode imports vehicles without ever holding the key. A
 * catalog failure becomes a typed RPC error; its message is the adapter's,
 * which never contains the key, and the RPC layer redacts it again.
 */
export interface VehicleRpcDeps {
  readonly vehicleProfiles: VehicleProfileRepository;
  /** `null` when the daemon was started without `--oed-base-url`. */
  readonly vehicleCatalog: VehicleCatalog | null;
}

export function listVehicleProfiles(deps: VehicleRpcDeps) {
  return deps.vehicleProfiles.list();
}

export function saveVehicleProfile(
  deps: VehicleRpcDeps,
  { profile }: Params<"vehicle_profiles.save">,
) {
  try {
    return deps.vehicleProfiles.save(profile);
  } catch (error) {
    if (error instanceof VehicleProfileLimitError) {
      throw new RpcFailure("invalid_params", error.message);
    }
    throw error;
  }
}

export function deleteVehicleProfile(
  deps: VehicleRpcDeps,
  { id }: Params<"vehicle_profiles.delete">,
): { ok: true } {
  if (!deps.vehicleProfiles.delete(id)) throw new RpcFailure("not_found", "");
  return { ok: true };
}

export function listCatalogMakes(deps: VehicleRpcDeps) {
  return withCatalog(deps, (c) => c.listMakes());
}

export function searchCatalogModels(
  deps: VehicleRpcDeps,
  params: Params<"vehicle_catalog.search_models">,
) {
  return withCatalog(deps, (c) => c.searchModels(params));
}

export function listCatalogVariants(
  deps: VehicleRpcDeps,
  { modelId, page }: Params<"vehicle_catalog.list_variants">,
) {
  return withCatalog(deps, (c) => c.listVariants(modelId, page));
}

export function getCatalogVariant(
  deps: VehicleRpcDeps,
  { variantId }: Params<"vehicle_catalog.get_variant">,
) {
  return withCatalog(deps, (c) => c.getVariant(variantId));
}

async function withCatalog<T>(
  deps: VehicleRpcDeps,
  call: (catalog: VehicleCatalog) => Promise<T>,
): Promise<T> {
  if (!deps.vehicleCatalog) {
    throw new RpcFailure(
      "unavailable",
      "No vehicle catalog is configured on the daemon; start it with --oed-base-url or OED_BASE_URL",
    );
  }
  try {
    return await call(deps.vehicleCatalog);
  } catch (error) {
    if (error instanceof VehicleCatalogError) {
      throw new RpcFailure(rpcCodeOf(error), error.message, {
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    throw error;
  }
}

/** How each catalog failure reads on the wire (the console maps it back). */
function rpcCodeOf(error: VehicleCatalogError): RpcErrorCode {
  switch (error.kind) {
    case "unauthorized":
    case "not_found":
    case "rate_limited":
    case "timeout":
      return error.kind;
    case "invalid_request":
      return "invalid_params";
    case "not_configured":
    case "unavailable":
    case "network":
    case "invalid_response":
      return "unavailable";
  }
}
