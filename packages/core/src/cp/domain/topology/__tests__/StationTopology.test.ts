import { describe, expect, it } from "vitest";
import { StationTopology, type TopologyAddress } from "../StationTopology";

/** The mapping every station used before StationTopology (#628): connector 0
 *  is the station, connector k is EVSE k, connector 1. */
function legacyAddress(k: number): TopologyAddress {
  return k === 0
    ? { scope: "station" }
    : { scope: "connector", evseId: k, connectorId: 1 };
}

describe("StationTopology.identity", () => {
  it.each([0, 1, 2, 5])(
    "maps every connector of a %i-connector station as before",
    (n) => {
      const topology = StationTopology.identity(n);
      for (let k = 0; k <= n; k++) {
        expect(topology.addressOf(k)).toEqual(legacyAddress(k));
      }
    },
  );

  it("keeps the legacy address for an id outside the station", () => {
    expect(StationTopology.identity(2).addressOf(7)).toEqual(legacyAddress(7));
  });

  it("is the 1:1 station", () => {
    const topology = StationTopology.identity(3);
    expect(topology.isIdentity).toBe(true);
    expect(topology.evseIds).toEqual([1, 2, 3]);
    expect(topology.connectorCount).toBe(3);
    expect(StationTopology.identity(0).evseIds).toEqual([]);
  });

  it("resolves (evseId, connectorId) only for connector 1 of a known EVSE", () => {
    const topology = StationTopology.identity(2);
    expect(topology.connectorAt(1, 1)).toBe(1);
    expect(topology.connectorAt(2, 1)).toBe(2);
    // OCPP 2.0.1 F05.FR.03 / G04: a connector the EVSE does not have.
    expect(topology.connectorAt(1, 2)).toBeUndefined();
    expect(topology.connectorAt(1, 0)).toBeUndefined();
    expect(topology.connectorAt(3, 1)).toBeUndefined();
    expect(topology.connectorAt(0, 1)).toBeUndefined();
    expect(topology.connectorAt(-1, 1)).toBeUndefined();
    expect(topology.connectorAt(1.5, 1)).toBeUndefined();
  });

  it("groups each connector alone in its EVSE", () => {
    const topology = StationTopology.identity(2);
    expect(topology.connectorsOf(1)).toEqual([1]);
    expect(topology.connectorsOf(2)).toEqual([2]);
    expect(topology.connectorsOf(0)).toEqual([]);
    expect(topology.connectorsOf(3)).toEqual([]);
    expect(topology.evseOf(1)).toBe(1);
    expect(topology.evseOf(2)).toBe(2);
    expect(topology.evseOf(0)).toBeUndefined();
    expect(topology.evseOf(3)).toBeUndefined();
    expect(topology.siblingsOf(1)).toEqual([]);
    expect(topology.siblingsOf(9)).toEqual([]);
  });

  it("declares nothing about a connector", () => {
    expect(StationTopology.identity(1).specOf(1)).toEqual({});
    expect(StationTopology.identity(1).specOf(4)).toEqual({});
  });
});
