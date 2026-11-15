/**
 * How the station's domain connectors group into EVSEs (#628).
 *
 * The domain keys every connector by a flat id 1..N: the OCPP 1.6 connectorId
 * (1.6 §3.8: numbered from 1, no gaps), the persisted `connector_id`, the
 * control-plane `connector` and a scenario's binding. OCPP 2.0.1 / 2.1 address
 * a connector as `(evseId, connectorId)`, where `connectorId` is the index
 * within the EVSE, numbered from 1 per EVSE (2.0.1 Part 2 §2.4 "Charging
 * Station, EVSE and Connector"). This value object is the one place that maps
 * between the two; protocol-agnostic and immutable.
 *
 * Flat ids are assigned in EVSE order, then in order within the EVSE: with
 * EVSE 1 holding two connectors and EVSE 2 one, connectors 1 and 2 belong to
 * EVSE 1 and connector 3 to EVSE 2.
 *
 * Today every station is {@link StationTopology.identity}: each connector has
 * an EVSE of its own, so EVSE k holds exactly domain connector k as its
 * connector 1.
 */

export type TopologyAddress =
  | { readonly scope: "station" }
  | { readonly scope: "evse"; readonly evseId: number }
  | {
      readonly scope: "connector";
      readonly evseId: number;
      readonly connectorId: number;
    };

/** The hardware of one connector. Empty for now; the connector type and the
 *  lock mechanism land with the configurable topology. */
export interface ConnectorSpec {
  /** OCPP 2.x connector type name (2.1 ConnectorEnumStringType, at most 20
   *  characters). Absent: not declared. */
  readonly connectorType?: string;
}

/** The connectors of one EVSE, in EVSE-local order (index 0 = connector 1). */
export interface EvseSpec {
  readonly connectors: readonly ConnectorSpec[];
}

interface ConnectorSlot {
  readonly evseId: number;
  /** 1-based index within the EVSE. */
  readonly evseConnectorId: number;
  readonly spec: ConnectorSpec;
}

const NO_SPEC: ConnectorSpec = Object.freeze({});
const NONE: readonly number[] = Object.freeze([]);

export class StationTopology {
  /** Domain connector k -> its slot; index k - 1. */
  private readonly slots: readonly ConnectorSlot[];
  /** EVSE e -> its domain connectors; index e - 1. */
  private readonly members: readonly (readonly number[])[];
  /** Every EVSE has exactly one connector (the 1:1 station). */
  readonly isIdentity: boolean;
  /** The EVSE ids, 1..E. */
  readonly evseIds: readonly number[];

  private constructor(evses: readonly EvseSpec[]) {
    const slots: ConnectorSlot[] = [];
    const members: number[][] = [];
    evses.forEach((evse, index) => {
      const evseId = index + 1;
      const ids: number[] = [];
      evse.connectors.forEach((spec, at) => {
        slots.push({ evseId, evseConnectorId: at + 1, spec });
        ids.push(slots.length);
      });
      members.push(Object.freeze(ids) as number[]);
    });
    this.slots = Object.freeze(slots);
    this.members = Object.freeze(members);
    this.evseIds = Object.freeze(evses.map((_, index) => index + 1));
    this.isIdentity = evses.every((evse) => evse.connectors.length === 1);
  }

  /**
   * The 1:1 station: domain connector k is EVSE k, connector 1. Every
   * station is built this way until the topology is configurable.
   */
  static identity(connectorCount: number): StationTopology {
    const count = Math.max(0, Math.floor(connectorCount));
    return new StationTopology(
      Array.from({ length: count }, () => ({ connectors: [NO_SPEC] })),
    );
  }

  /** Number of domain connectors. */
  get connectorCount(): number {
    return this.slots.length;
  }

  /**
   * The 2.x address of a domain connector: 0 is the station (EVSE 0);
   * k > 0 is `{ evseId, connectorId }` with `connectorId` the index within
   * the EVSE. An id outside the topology keeps the identity mapping, so a
   * caller that names a connector the station does not have still renders
   * the wire reference it always did.
   */
  addressOf(connectorId: number): TopologyAddress {
    if (connectorId === 0) return { scope: "station" };
    const slot = this.slotOf(connectorId);
    return slot
      ? {
          scope: "connector",
          evseId: slot.evseId,
          connectorId: slot.evseConnectorId,
        }
      : { scope: "connector", evseId: connectorId, connectorId: 1 };
  }

  /** The domain connector at `(evseId, evseConnectorId)`, or undefined when
   *  the station has no such EVSE or the EVSE no such connector. */
  connectorAt(evseId: number, evseConnectorId: number): number | undefined {
    const ids = this.connectorsOf(evseId);
    if (!Number.isInteger(evseConnectorId) || evseConnectorId < 1) {
      return undefined;
    }
    return ids[evseConnectorId - 1];
  }

  /** The domain connectors of an EVSE in EVSE-local order; empty for an
   *  unknown EVSE (and for EVSE 0, the station). */
  connectorsOf(evseId: number): readonly number[] {
    if (!Number.isInteger(evseId) || evseId < 1) return NONE;
    return this.members[evseId - 1] ?? NONE;
  }

  /** The EVSE of a domain connector, or undefined for 0 and unknown ids. */
  evseOf(connectorId: number): number | undefined {
    return this.slotOf(connectorId)?.evseId;
  }

  /** The other connectors of the same EVSE (none on a 1:1 station). */
  siblingsOf(connectorId: number): readonly number[] {
    const evseId = this.evseOf(connectorId);
    if (evseId === undefined) return NONE;
    return this.connectorsOf(evseId).filter((id) => id !== connectorId);
  }

  /** What the station declares about a connector; empty when nothing is. */
  specOf(connectorId: number): ConnectorSpec {
    return this.slotOf(connectorId)?.spec ?? NO_SPEC;
  }

  private slotOf(connectorId: number): ConnectorSlot | undefined {
    if (!Number.isInteger(connectorId) || connectorId < 1) return undefined;
    return this.slots[connectorId - 1];
  }
}
