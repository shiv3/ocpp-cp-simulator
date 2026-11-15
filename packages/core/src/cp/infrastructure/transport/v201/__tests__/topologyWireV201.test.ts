import { describe, expect, it } from "vitest";
import {
  v201EvseExists,
  v201EvseTargets,
  v201MeterEvseId,
  v201StatusEvse,
  v201TransactionEvse,
} from "../topologyWireV201";
import { StationTopology } from "../../../../domain/topology/StationTopology";

const topology = StationTopology.identity(5);

describe("topologyWireV201", () => {
  it("renders StatusNotification station and connector targets", () => {
    expect(v201StatusEvse(topology, 0)).toEqual({ evseId: 0, connectorId: 0 });
    expect(v201StatusEvse(topology, 1)).toEqual({ evseId: 1, connectorId: 1 });
    expect(v201StatusEvse(topology, 3)).toEqual({ evseId: 3, connectorId: 1 });
    expect(v201StatusEvse(topology, 5)).toEqual({ evseId: 5, connectorId: 1 });
    expect(Object.keys(v201StatusEvse(topology, 0))).toEqual([
      "evseId",
      "connectorId",
    ]);
    expect(Object.keys(v201StatusEvse(topology, 3))).toEqual([
      "evseId",
      "connectorId",
    ]);
  });

  it("renders TransactionEvent evse refs in wire key order", () => {
    const evse = v201TransactionEvse(topology, 3);

    expect(evse).toEqual({ id: 3, connectorId: 1 });
    expect(Object.keys(evse)).toEqual(["id", "connectorId"]);
  });

  it.each([
    [{ id: 1 }, true],
    [{ id: 2, connectorId: 1 }, true],
    [{ id: 0 }, false],
    [{ id: 3 }, false],
    [{ id: 1, connectorId: 0 }, false],
    [{ id: 1, connectorId: 2 }, false],
  ])("resolves EVSE %j on connectors 1-2 as %s", (evse, exists) => {
    expect(
      v201EvseExists(StationTopology.identity(2), evse, new Set([1, 2])),
    ).toBe(exists);
  });

  it("renders MeterValues evseId", () => {
    expect(v201MeterEvseId(topology, 2)).toBe(2);
  });

  it("resolves the connectors an EVSEType targets as before on 1:1 stations", () => {
    const two = StationTopology.identity(2);
    expect(v201EvseTargets(two, undefined)).toBeUndefined();
    expect(v201EvseTargets(two, { id: 0 })).toBeUndefined();
    expect(v201EvseTargets(two, { id: 2 })).toEqual([2]);
    expect(v201EvseTargets(two, { id: 1, connectorId: 1 })).toEqual([1]);
    // Unresolved: the EVSE's connectors, then the EVSE id, which the
    // station reports as an unknown connector as it always did.
    expect(v201EvseTargets(two, { id: 1, connectorId: 2 })).toEqual([1]);
    expect(v201EvseTargets(two, { id: 9 })).toEqual([9]);
  });
});
