import { describe, expect, it } from "vitest";
import { addressForConnectorId } from "../TopologyAddress";

describe("TopologyAddress", () => {
  it("maps connectorId 0 to station scope", () => {
    expect(addressForConnectorId(0)).toEqual({ scope: "station" });
  });

  it("maps connectorId 1 to EVSE 1 connector 1", () => {
    expect(addressForConnectorId(1)).toEqual({
      scope: "connector",
      evseId: 1,
      connectorId: 1,
    });
  });

  it("maps connectorId 5 to EVSE 5 connector 1", () => {
    expect(addressForConnectorId(5)).toEqual({
      scope: "connector",
      evseId: 5,
      connectorId: 1,
    });
  });
});
