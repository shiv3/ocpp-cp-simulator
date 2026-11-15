import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import {
  resolveNetworkSimConfig,
  validateLayerConfig,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import { networkSimAtom, type NetworkSimStore } from "../../store/store";
import type { getDefaultStore } from "jotai";

/** What the network-sim helpers need from LocalChargePointService. */
export interface LocalNetworkSimHost {
  readonly store: ReturnType<typeof getDefaultStore>;
  readonly chargePoints: ReadonlyMap<string, ChargePoint>;
}

export function readNetworkSimStore(
  host: LocalNetworkSimHost,
): NetworkSimStore {
  try {
    const value = host.store.get(networkSimAtom);
    if (!value || typeof value !== "object") {
      console.warn(
        "[LocalChargePointService] Invalid networkSim store value, using disabled default",
      );
      return { version: 1, global: null, perCp: {} };
    }

    const storeValue = value as unknown as Record<string, unknown>;
    const version = storeValue.version;

    // Validate version
    if (version !== 1) {
      console.warn(
        `[LocalChargePointService] Unsupported networkSim store version ${version}, using disabled default`,
      );
      return { version: 1, global: null, perCp: {} };
    }

    // Validate global layer
    let globalLayer: NetworkSimLayerConfig | null = null;
    if (storeValue.global !== null && storeValue.global !== undefined) {
      const globalValidation = validateLayerConfig(storeValue.global);
      if (globalValidation.ok) {
        globalLayer = globalValidation.config;
      } else {
        console.warn(
          "[LocalChargePointService] Invalid global networkSim config:",
          globalValidation.errors,
        );
      }
    }

    // Validate perCp layers
    const perCp: Record<string, NetworkSimLayerConfig> = {};
    if (
      storeValue.perCp &&
      typeof storeValue.perCp === "object" &&
      !Array.isArray(storeValue.perCp)
    ) {
      for (const [cpId, layer] of Object.entries(storeValue.perCp)) {
        if (layer !== null && layer !== undefined) {
          const perCpValidation = validateLayerConfig(layer);
          if (perCpValidation.ok) {
            perCp[cpId] = perCpValidation.config;
          } else {
            console.warn(
              `[LocalChargePointService] Invalid per-CP networkSim config for ${cpId}:`,
              perCpValidation.errors,
            );
          }
        }
      }
    }

    return { version: 1, global: globalLayer, perCp };
  } catch (error) {
    console.warn(
      "[LocalChargePointService] Failed to read networkSim store:",
      error,
    );
    return { version: 1, global: null, perCp: {} };
  }
}

export function getResolvedFor(
  host: LocalNetworkSimHost,
  cpId: string,
): ResolvedNetworkSimConfig {
  const store = readNetworkSimStore(host);
  return resolveNetworkSimConfig(store.global, store.perCp[cpId] ?? null, cpId);
}

export function reapplyToAllLiveCps(host: LocalNetworkSimHost): void {
  host.chargePoints.forEach((cp) => {
    cp.setNetworkSimConfig(getResolvedFor(host, cp.id));
  });
}

export async function getNetworkSimGlobal(
  host: LocalNetworkSimHost,
): Promise<NetworkSimLayerConfig | null> {
  return readNetworkSimStore(host).global;
}

export async function saveNetworkSimGlobal(
  host: LocalNetworkSimHost,
  config: NetworkSimLayerConfig | null,
): Promise<void> {
  if (config !== null) {
    const validation = validateLayerConfig(config);
    if (!validation.ok) {
      throw new Error(
        `Invalid global networkSim config: ${Object.entries(validation.errors)
          .map(([key, msg]) => `${key}: ${msg}`)
          .join("; ")}`,
      );
    }
  }

  const prev = readNetworkSimStore(host);
  host.store.set(networkSimAtom, { ...prev, global: config });

  // Fan out to all live CPs
  host.chargePoints.forEach((cp) => {
    const resolved = resolveNetworkSimConfig(
      config,
      prev.perCp[cp.id] ?? null,
      cp.id,
    );
    cp.setNetworkSimConfig(resolved);
  });
}

export async function getNetworkSimCp(
  host: LocalNetworkSimHost,
  cpId: string,
): Promise<{
  config: NetworkSimLayerConfig | null;
  resolved: ResolvedNetworkSimConfig;
}> {
  const store = readNetworkSimStore(host);
  return {
    config: store.perCp[cpId] ?? null,
    resolved: resolveNetworkSimConfig(
      store.global,
      store.perCp[cpId] ?? null,
      cpId,
    ),
  };
}

export async function saveNetworkSimCp(
  host: LocalNetworkSimHost,
  cpId: string,
  config: NetworkSimLayerConfig | null,
): Promise<void> {
  if (config !== null) {
    const validation = validateLayerConfig(config);
    if (!validation.ok) {
      throw new Error(
        `Invalid per-CP networkSim config for ${cpId}: ${Object.entries(
          validation.errors,
        )
          .map(([key, msg]) => `${key}: ${msg}`)
          .join("; ")}`,
      );
    }
  }

  const prev = readNetworkSimStore(host);
  const newPerCp = { ...prev.perCp };
  if (config === null) {
    delete newPerCp[cpId];
  } else {
    newPerCp[cpId] = config;
  }

  host.store.set(networkSimAtom, { ...prev, perCp: newPerCp });

  // Apply resolved config to the live CP if present
  const cp = host.chargePoints.get(cpId);
  if (cp) {
    const resolved = resolveNetworkSimConfig(prev.global, config, cpId);
    cp.setNetworkSimConfig(resolved);
  }
}

export async function triggerNetworkSimDisconnect(
  host: LocalNetworkSimHost,
  cpId: string,
  ruleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cp = host.chargePoints.get(cpId);
  if (!cp) {
    return { ok: false, error: "not_connected" };
  }
  return cp.triggerNetworkSimDisconnect(ruleId);
}
