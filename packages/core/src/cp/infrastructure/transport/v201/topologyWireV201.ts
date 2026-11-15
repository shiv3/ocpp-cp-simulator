// v201 wire encoding of the domain connectorId into EVSE references (#628).
// The station's `StationTopology` maps a domain connector to `(evseId,
// connectorId)`; on the 1:1 station connector N > 0 is EVSE N, connector 1,
// and connector 0 is the station. This module renders the WIRE-only refs.

import type { StationTopology } from "../../../domain/topology/StationTopology";

/** v201 StatusNotification target. Station (0) -> {evseId:0, connectorId:0};
 *  a connector -> its `(evseId, connectorId)` in the topology. */
export function v201StatusEvse(
  topology: StationTopology,
  connectorId: number,
): {
  evseId: number;
  connectorId: number;
} {
  const addr = topology.addressOf(connectorId);

  switch (addr.scope) {
    case "station":
      return { evseId: 0, connectorId: 0 };
    case "connector":
      return { evseId: addr.evseId, connectorId: addr.connectorId };
    case "evse":
      return { evseId: addr.evseId, connectorId: 0 };
  }
}

/** v201 TransactionEvent `evse` ref (key order: id, connectorId). */
export function v201TransactionEvse(
  topology: StationTopology,
  connectorId: number,
): {
  id: number;
  connectorId: number;
} {
  const addr = topology.addressOf(connectorId);
  return addr.scope === "connector"
    ? { id: addr.evseId, connectorId: addr.connectorId }
    : { id: connectorId, connectorId: 1 };
}

/**
 * Whether a wire `EVSEType` names an EVSE (and, with `connectorId`, a
 * connector of it) that the station has (#538): the topology resolves the
 * pair, and the resolved domain connector is still in `connectors` (a
 * connector removed at run time is gone).
 */
export function v201EvseExists(
  topology: StationTopology,
  evse: { id: number; connectorId?: number },
  connectors: { has(id: number): boolean },
): boolean {
  const ids =
    evse.connectorId === undefined
      ? topology.connectorsOf(evse.id)
      : [topology.connectorAt(evse.id, evse.connectorId)];
  return ids.some((id) => id !== undefined && connectors.has(id));
}

/** v201 MeterValues evseId: the EVSE of the domain connector. */
export function v201MeterEvseId(
  topology: StationTopology,
  connectorId: number,
): number {
  return topology.evseOf(connectorId) ?? connectorId;
}

/**
 * The domain connectors a CSMS CALL's `EVSEType` targets: the connector at
 * `(id, connectorId)`, or every connector of EVSE `id` (2.0.1 F06.FR.12 lets
 * TriggerMessage(StatusNotification) for a whole EVSE answer for all of its
 * connectors). `undefined` for the station (no EVSE, or EVSE 0). A pair the
 * topology does not resolve falls back to the EVSE's connectors and then to
 * `[id]`, so the caller reports the unknown connector as it always did.
 */
export function v201EvseTargets(
  topology: StationTopology,
  evse: { id: number; connectorId?: number } | undefined,
): number[] | undefined {
  if (evse === undefined || evse.id === 0) return undefined;
  const at =
    evse.connectorId === undefined
      ? undefined
      : topology.connectorAt(evse.id, evse.connectorId);
  if (at !== undefined) return [at];
  const all = topology.connectorsOf(evse.id);
  return all.length > 0 ? [...all] : [evse.id];
}
