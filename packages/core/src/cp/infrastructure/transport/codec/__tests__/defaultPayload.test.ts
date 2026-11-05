import { describe, expect, it } from "vitest";

import { defaultPayloadFromSchema } from "../defaultPayload";

describe("defaultPayloadFromSchema", () => {
  it("fills only the required properties", () => {
    expect(
      defaultPayloadFromSchema({
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
        },
        required: ["a"],
      }),
    ).toEqual({ a: "" });
  });

  it("picks the first enum value, now for date-time and the minimum for numbers", () => {
    const payload = defaultPayloadFromSchema({
      type: "object",
      properties: {
        status: { type: "string", enum: ["Accepted", "Rejected"] },
        at: { type: "string", format: "date-time" },
        count: { type: "integer", minimum: 1 },
        ratio: { type: "number" },
        flag: { type: "boolean" },
      },
      required: ["status", "at", "count", "ratio", "flag"],
    }) as Record<string, unknown>;
    expect(payload.status).toBe("Accepted");
    expect(Number.isNaN(Date.parse(payload.at as string))).toBe(false);
    expect(payload.count).toBe(1);
    expect(payload.ratio).toBe(0);
    expect(payload.flag).toBe(false);
  });

  it("resolves local definitions and fills arrays up to minItems", () => {
    expect(
      defaultPayloadFromSchema({
        definitions: {
          Item: {
            type: "object",
            properties: { id: { type: "string", minLength: 3 } },
            required: ["id"],
          },
        },
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/definitions/Item" },
            minItems: 1,
          },
        },
        required: ["items"],
      }),
    ).toEqual({ items: [{ id: "xxx" }] });
  });
});
