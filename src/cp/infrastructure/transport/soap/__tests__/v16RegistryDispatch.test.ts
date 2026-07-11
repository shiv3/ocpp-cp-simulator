import { describe, it, expect } from "vitest";
import {
  coerceSoapPayloadWithSchema,
  transformResponseForOcpp12,
} from "../v16RegistryDispatch";

type TestSchema = Record<string, unknown>;

describe("coerceSoapPayloadWithSchema", () => {
  it("coerces string integers to numbers", () => {
    const schema: TestSchema = {
      properties: {
        connectorId: { type: "integer" },
        idTag: { type: "string" },
      },
    };

    const payload = {
      connectorId: "1",
      idTag: "TAG123",
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      connectorId: 1,
      idTag: "TAG123",
    });
  });

  it("coerces string booleans to boolean values", () => {
    const schema = {
      properties: {
        authorized: { type: "boolean" },
      },
    };

    const payload = {
      authorized: "true",
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      authorized: true,
    });
  });

  it("coerces false string to boolean false", () => {
    const schema = {
      properties: {
        flag: { type: "boolean" },
      },
    };

    const payload = {
      flag: "false",
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      flag: false,
    });
  });

  it("wraps single element in array when schema expects array", () => {
    const schema = {
      properties: {
        values: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    const payload = {
      values: "single_value",
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      values: ["single_value"],
    });
  });

  it("preserves already-array values", () => {
    const schema = {
      properties: {
        values: { type: "array" },
      },
    };

    const payload = {
      values: ["a", "b", "c"],
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      values: ["a", "b", "c"],
    });
  });

  it("recursively coerces nested objects", () => {
    const schema = {
      properties: {
        chargingProfile: {
          type: "object",
          properties: {
            chargingProfileId: { type: "integer" },
            stackLevel: { type: "integer" },
          },
        },
      },
    };

    const payload = {
      chargingProfile: {
        chargingProfileId: "42",
        stackLevel: "1",
      },
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      chargingProfile: {
        chargingProfileId: 42,
        stackLevel: 1,
      },
    });
  });

  it("coerces numeric fields inside arrays of objects (SetChargingProfile periods)", () => {
    const schema = {
      properties: {
        chargingSchedulePeriod: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startPeriod: { type: "integer" },
              limit: { type: "number" },
            },
          },
        },
      },
    };

    // Two periods → real array; each period's numeric fields are strings.
    const payload = {
      chargingSchedulePeriod: [
        { startPeriod: "0", limit: "32.0" },
        { startPeriod: "3600", limit: "16" },
      ],
    };

    expect(
      coerceSoapPayloadWithSchema(payload, schema as Record<string, unknown>),
    ).toEqual({
      chargingSchedulePeriod: [
        { startPeriod: 0, limit: 32.0 },
        { startPeriod: 3600, limit: 16 },
      ],
    });
  });

  it("wraps a single array element AND coerces its nested numbers", () => {
    const schema = {
      properties: {
        chargingSchedulePeriod: {
          type: "array",
          items: {
            type: "object",
            properties: { startPeriod: { type: "integer" } },
          },
        },
      },
    };

    // fast-xml-parser yields a lone object (not an array) for a single element.
    const payload = { chargingSchedulePeriod: { startPeriod: "900" } };

    expect(
      coerceSoapPayloadWithSchema(payload, schema as Record<string, unknown>),
    ).toEqual({
      chargingSchedulePeriod: [{ startPeriod: 900 }],
    });
  });

  it("does not throw or mangle when an object-typed field is null or an array", () => {
    const schema = {
      properties: {
        chargingProfile: {
          type: "object",
          properties: { chargingProfileId: { type: "integer" } },
        },
      },
    };

    expect(
      coerceSoapPayloadWithSchema(
        { chargingProfile: null },
        schema as Record<string, unknown>,
      ),
    ).toEqual({ chargingProfile: null });

    // An array must not be walked as an index-keyed record ({0: ...}).
    expect(
      coerceSoapPayloadWithSchema(
        { chargingProfile: ["x"] },
        schema as Record<string, unknown>,
      ),
    ).toEqual({ chargingProfile: ["x"] });
  });

  it("passes through unknown keys untouched", () => {
    const schema = {
      properties: {
        knownKey: { type: "string" },
      },
    };

    const payload = {
      knownKey: "value",
      unknownKey: "should_pass_through",
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      knownKey: "value",
      unknownKey: "should_pass_through",
    });
  });

  it("handles number types", () => {
    const schema = {
      properties: {
        price: { type: "number" },
      },
    };

    const payload = {
      price: "99.99",
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      price: 99.99,
    });
  });

  it("returns payload as-is when schema is missing", () => {
    const payload = {
      connectorId: "1",
      idTag: "TAG123",
    };

    const result = coerceSoapPayloadWithSchema(payload, undefined);
    expect(result).toEqual(payload);
  });

  it("returns payload as-is when schema.properties is missing", () => {
    const schema = {};
    const payload = {
      connectorId: "1",
      idTag: "TAG123",
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual(payload);
  });

  it("complex scenario: RemoteStartTransaction-like payload", () => {
    const schema = {
      properties: {
        connectorId: { type: "integer" },
        idTag: { type: "string" },
        chargingProfile: {
          type: "object",
          properties: {
            chargingProfileId: { type: "integer" },
            stackLevel: { type: "integer" },
            chargingProfilePurpose: { type: "string" },
            chargingProfileKind: { type: "string" },
          },
        },
      },
    };

    const payload = {
      connectorId: "1",
      idTag: "TAG123",
      chargingProfile: {
        chargingProfileId: "42",
        stackLevel: "0",
        chargingProfilePurpose: "TxProfile",
        chargingProfileKind: "Absolute",
      },
    };

    const result = coerceSoapPayloadWithSchema(
      payload,
      schema as Record<string, unknown>,
    );
    expect(result).toEqual({
      connectorId: 1,
      idTag: "TAG123",
      chargingProfile: {
        chargingProfileId: 42,
        stackLevel: 0,
        chargingProfilePurpose: "TxProfile",
        chargingProfileKind: "Absolute",
      },
    });
  });
});

describe("transformResponseForOcpp12", () => {
  it("transforms UnlockConnector Unlocked to Accepted", () => {
    const response = { status: "Unlocked" };
    const result = transformResponseForOcpp12("UnlockConnector", response);
    expect(result).toEqual({ status: "Accepted" });
  });

  it("transforms UnlockConnector UnlockFailed to Rejected", () => {
    const response = { status: "UnlockFailed" };
    const result = transformResponseForOcpp12("UnlockConnector", response);
    expect(result).toEqual({ status: "Rejected" });
  });

  it("transforms UnlockConnector NotSupported to Rejected", () => {
    const response = { status: "NotSupported" };
    const result = transformResponseForOcpp12("UnlockConnector", response);
    expect(result).toEqual({ status: "Rejected" });
  });

  it("transforms ChangeConfiguration RebootRequired to Accepted", () => {
    const response = { status: "RebootRequired" };
    const result = transformResponseForOcpp12("ChangeConfiguration", response);
    expect(result).toEqual({ status: "Accepted" });
  });

  it("leaves ChangeConfiguration NotSupported unchanged", () => {
    const response = { status: "NotSupported" };
    const result = transformResponseForOcpp12("ChangeConfiguration", response);
    expect(result).toEqual({ status: "NotSupported" });
  });

  it("leaves ChangeAvailability Scheduled unchanged", () => {
    const response = { status: "Scheduled" };
    const result = transformResponseForOcpp12("ChangeAvailability", response);
    expect(result).toEqual({ status: "Scheduled" });
  });

  it("leaves Reset Accepted unchanged", () => {
    const response = { status: "Accepted" };
    const result = transformResponseForOcpp12("Reset", response);
    expect(result).toEqual({ status: "Accepted" });
  });

  it("leaves ClearCache Accepted unchanged", () => {
    const response = { status: "Accepted" };
    const result = transformResponseForOcpp12("ClearCache", response);
    expect(result).toEqual({ status: "Accepted" });
  });

  it("leaves non-transformed UnlockConnector Accepted unchanged", () => {
    const response = { status: "Accepted" };
    const result = transformResponseForOcpp12("UnlockConnector", response);
    expect(result).toEqual({ status: "Accepted" });
  });

  it("leaves non-transformed UnlockConnector Rejected unchanged", () => {
    const response = { status: "Rejected" };
    const result = transformResponseForOcpp12("UnlockConnector", response);
    expect(result).toEqual({ status: "Rejected" });
  });

  it("transforms ChangeConfiguration Accepted and preserves other fields", () => {
    const response = { status: "RebootRequired", configKey: "testKey" };
    const result = transformResponseForOcpp12("ChangeConfiguration", response);
    expect(result).toEqual({
      status: "Accepted",
      configKey: "testKey",
    });
  });

  it("transforms UnlockConnector UnlockFailed and preserves other fields", () => {
    const response = { status: "UnlockFailed", extra: "field" };
    const result = transformResponseForOcpp12("UnlockConnector", response);
    expect(result).toEqual({
      status: "Rejected",
      extra: "field",
    });
  });
});
