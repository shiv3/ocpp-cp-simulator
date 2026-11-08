/**
 * What the charger hardware can deliver (#327): the charger side of
 * "vehicle demand ∩ charger capability ∩ external allocation". Not what the
 * EV accepts (`EVSettings.maxChargingPowerKw`) and not what the CSMS allows
 * (a charging profile); the three compose in `resolveOperatingPoint`.
 *
 * Plain JSON, carried through the `cp.create` parameters, a blueprint's
 * `params`, `ChargePointInitOptions`, the `charge_points` row and the runtime
 * `Connector`. Protocol-agnostic: nothing here imports `ocpp/` or a transport.
 */
export interface ChargerCapabilities {
  /** Per-connector hardware. A connector not listed is uncapped. */
  readonly connectors: ReadonlyArray<ConnectorCapability>;
}

export interface ConnectorCapability {
  /** 1-based connector id, as on the wire. */
  readonly connectorId: number;
  /** The most the hardware delivers on this connector, in watts (> 0). The
   *  aggregate of a station is deliberately not modelled: there is no power
   *  sharing, so connectors are never clamped to a sum. */
  readonly maxDeliveryPowerW: number;
}

/** The delivery cap of `connectorId` in watts, `undefined` when none. */
export function maxDeliveryPowerWFor(
  capabilities: ChargerCapabilities | undefined,
  connectorId: number,
): number | undefined {
  return capabilities?.connectors.find((c) => c.connectorId === connectorId)
    ?.maxDeliveryPowerW;
}

/** The capabilities for `count` identical connectors capped at `kw` each. */
export function uniformChargerCapabilities(
  count: number,
  kw: number,
): {
  connectors: Array<{ connectorId: number; maxDeliveryPowerW: number }>;
} {
  return {
    connectors: Array.from({ length: count }, (_, i) => ({
      connectorId: i + 1,
      maxDeliveryPowerW: kw * 1000,
    })),
  };
}

/**
 * Why `value` is not usable chargerCapabilities, or `null`. Used where JSON
 * enters the system (the HTTP body, a stored row) that the zod schema of the
 * control plane does not cover.
 */
export function chargerCapabilitiesProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "chargerCapabilities must be an object";
  }
  const connectors = (value as { connectors?: unknown }).connectors;
  if (!Array.isArray(connectors)) {
    return "chargerCapabilities.connectors must be an array";
  }
  const seen = new Set<number>();
  for (const entry of connectors) {
    if (typeof entry !== "object" || entry === null) {
      return "chargerCapabilities.connectors entries must be objects";
    }
    const { connectorId, maxDeliveryPowerW } = entry as Record<string, unknown>;
    if (
      typeof connectorId !== "number" ||
      !Number.isInteger(connectorId) ||
      connectorId < 1
    ) {
      return "chargerCapabilities connectorId must be an integer of at least 1";
    }
    if (seen.has(connectorId)) {
      return `chargerCapabilities names connector ${connectorId} twice`;
    }
    seen.add(connectorId);
    if (
      typeof maxDeliveryPowerW !== "number" ||
      !Number.isFinite(maxDeliveryPowerW) ||
      maxDeliveryPowerW <= 0
    ) {
      return "chargerCapabilities maxDeliveryPowerW must be a positive number of watts";
    }
  }
  return null;
}
