import { describe, expect, it } from "vitest";

import { parseCreateBody } from "../httpServer";

function createBody(ocppVersion: string) {
  return {
    cpId: "CP-1",
    wsUrl: "ws://127.0.0.1:9000/ocpp",
    ocppVersion,
  };
}

describe("parseCreateBody ocppVersion", () => {
  it.each(["OCPP-1.5", "OCPP-1.6J", "OCPP-2.0.1", "OCPP-2.1"])(
    "accepts %s",
    (ocppVersion) => {
      expect(parseCreateBody(createBody(ocppVersion)).ocppVersion).toBe(
        ocppVersion,
      );
    },
  );

  it("rejects unsupported versions", () => {
    expect(() => parseCreateBody(createBody("OCPP-1.2"))).toThrow(
      "ocppVersion must be a supported OCPP version",
    );
  });
});
