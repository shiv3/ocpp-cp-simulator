export type TopologyAddress =
  | { readonly scope: "station" }
  | { readonly scope: "evse"; readonly evseId: number }
  | {
      readonly scope: "connector";
      readonly evseId: number;
      readonly connectorId: number;
    };

/** 1.6 projection: domain connectorId 0 -> station; N>0 -> EVSE N, connector 1.
 *  (1.6 models one connector per implicit EVSE; this mapping is intentionally non-reversible
 *  with 2.x, where evseId 0 is station/grid scope.) */
export function addressForConnectorId(
  domainConnectorId: number,
): TopologyAddress {
  return domainConnectorId === 0
    ? { scope: "station" }
    : { scope: "connector", evseId: domainConnectorId, connectorId: 1 };
}
