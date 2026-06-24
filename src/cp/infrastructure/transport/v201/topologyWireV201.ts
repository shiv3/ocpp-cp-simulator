// v201 wire encoding of the domain connectorId into EVSE references.
// OCPP 1.6 -> 2.0.1 projection: connectorId N>0 -> EVSE N, connector 1; connectorId 0 -> station.
// This is WIRE rendering only (no domain topology model yet).

/** v201 StatusNotification target. Station (0) -> {evseId:0, connectorId:0}; N -> {evseId:N, connectorId:1}. */
export function v201StatusEvse(connectorId: number): {
  evseId: number;
  connectorId: number;
} {
  return connectorId === 0
    ? { evseId: 0, connectorId: 0 }
    : { evseId: connectorId, connectorId: 1 };
}

/** v201 TransactionEvent `evse` ref (key order: id, connectorId). Matches the current literal exactly. */
export function v201TransactionEvse(connectorId: number): {
  id: number;
  connectorId: number;
} {
  return { id: connectorId, connectorId: 1 };
}

/** v201 MeterValues evseId. */
export function v201MeterEvseId(connectorId: number): number {
  return connectorId;
}
