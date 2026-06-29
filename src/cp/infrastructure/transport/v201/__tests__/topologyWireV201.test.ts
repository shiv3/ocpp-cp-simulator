import { describe, expect, it } from "vitest";
import {
  v201MeterEvseId,
  v201StatusEvse,
  v201TransactionEvse,
} from "../topologyWireV201";

describe("topologyWireV201", () => {
  it("renders StatusNotification station and connector targets", () => {
    expect(v201StatusEvse(0)).toEqual({ evseId: 0, connectorId: 0 });
    expect(v201StatusEvse(1)).toEqual({ evseId: 1, connectorId: 1 });
    expect(v201StatusEvse(3)).toEqual({ evseId: 3, connectorId: 1 });
    expect(v201StatusEvse(5)).toEqual({ evseId: 5, connectorId: 1 });
    expect(Object.keys(v201StatusEvse(0))).toEqual(["evseId", "connectorId"]);
    expect(Object.keys(v201StatusEvse(3))).toEqual(["evseId", "connectorId"]);
  });

  it("renders TransactionEvent evse refs in wire key order", () => {
    const evse = v201TransactionEvse(3);

    expect(evse).toEqual({ id: 3, connectorId: 1 });
    expect(Object.keys(evse)).toEqual(["id", "connectorId"]);
  });

  it("renders MeterValues evseId", () => {
    expect(v201MeterEvseId(2)).toBe(2);
  });
});
