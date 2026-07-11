import { describe, expect, it } from "vitest";

import { parseCreateBody } from "../httpServer";

function createBody(ocppVersion: string) {
  const body: {
    cpId: string;
    wsUrl: string;
    ocppVersion: string;
    soapCallbackUrl?: string;
  } = {
    cpId: "CP-1",
    wsUrl: "ws://127.0.0.1:9000/ocpp",
    ocppVersion,
  };
  if (
    ocppVersion === "OCPP-1.2" ||
    ocppVersion === "OCPP-1.5" ||
    ocppVersion === "OCPP-1.6S"
  ) {
    body.soapCallbackUrl =
      "http://127.0.0.1:9700/ocpp/soap/CP-1/ChargePointService";
  }
  return body;
}

describe("parseCreateBody ocppVersion", () => {
  it.each([
    "OCPP-1.2",
    "OCPP-1.5",
    "OCPP-1.6J",
    "OCPP-1.6S",
    "OCPP-2.0.1",
    "OCPP-2.1",
  ])("accepts %s", (ocppVersion) => {
    expect(parseCreateBody(createBody(ocppVersion)).ocppVersion).toBe(
      ocppVersion,
    );
  });

  it("rejects unsupported versions", () => {
    expect(() => parseCreateBody(createBody("OCPP-1.3"))).toThrow(
      "ocppVersion must be a supported OCPP version",
    );
  });

  it("accepts SOAP fields for OCPP-1.5", () => {
    expect(
      parseCreateBody({
        ...createBody("OCPP-1.5"),
        wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
        soapCallbackUrl:
          "http://127.0.0.1:9700/ocpp/soap/CP-1/ChargePointService",
        soapPath: "/ocpp/soap",
      }),
    ).toMatchObject({
      centralSystemUrl:
        "http://127.0.0.1:8180/steve/services/CentralSystemService",
      soapCallbackUrl:
        "http://127.0.0.1:9700/ocpp/soap/CP-1/ChargePointService",
      soapPath: "/ocpp/soap",
    });
  });

  it("rejects OCPP-1.5 without a SOAP callback URL", () => {
    expect(() =>
      parseCreateBody({
        cpId: "CP-1",
        wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
        ocppVersion: "OCPP-1.5",
      }),
    ).toThrow("soapCallbackUrl is required for OCPP SOAP versions");
  });

  it("rejects OCPP-1.2 without a SOAP callback URL", () => {
    expect(() =>
      parseCreateBody({
        cpId: "CP-1",
        wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
        ocppVersion: "OCPP-1.2",
      }),
    ).toThrow("soapCallbackUrl is required for OCPP SOAP versions");
  });

  it("rejects OCPP-1.6S without a SOAP callback URL", () => {
    expect(() =>
      parseCreateBody({
        cpId: "CP-1",
        wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
        ocppVersion: "OCPP-1.6S",
      }),
    ).toThrow("soapCallbackUrl is required for OCPP SOAP versions");
  });
});
