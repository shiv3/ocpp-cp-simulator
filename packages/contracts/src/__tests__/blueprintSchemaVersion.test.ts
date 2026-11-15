import { describe, expect, it } from "vitest";

import {
  BLUEPRINT_SCHEMA_VERSION,
  blueprintSchema,
  blueprintSourceSchema,
} from "../methods";

const BASE = {
  id: "site-a",
  name: "Site A wallbox",
  params: { connectors: 2, vendor: "Acme", model: "A2" },
};

const SHA = "a".repeat(64);

const SOURCE = {
  format: "manual",
  citations: "docs/examples/blueprints/site-a.sources.json",
  documents: [
    {
      id: "d1",
      title: "Implementation overview",
      publisher: "Acme",
      uri: "https://example.test/d1.pdf",
      revision: "v1",
      sha256: SHA,
      retrievedAt: "2026-11-15",
    },
  ],
  unmapped: [
    { what: "HeartbeatInterval default 120", documentId: "d1", locator: "p.9" },
  ],
};

describe("blueprint schemaVersion (#331)", () => {
  it("is 1 in this build", () => {
    expect(BLUEPRINT_SCHEMA_VERSION).toBe(1);
  });

  it("keeps a pre-versioned blueprint valid and unchanged", () => {
    // Stored rows from before the field existed must still parse, and parse to
    // exactly what was stored: `blueprint.list` output must not change.
    const parsed = blueprintSchema.parse(BASE);
    expect(parsed).toEqual(BASE);
    expect("schemaVersion" in parsed).toBe(false);
  });

  it("accepts 1 and refuses any other version", () => {
    expect(
      blueprintSchema.parse({ ...BASE, schemaVersion: 1 }).schemaVersion,
    ).toBe(1);
    expect(
      blueprintSchema.safeParse({ ...BASE, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      blueprintSchema.safeParse({ ...BASE, schemaVersion: "1" }).success,
    ).toBe(false);
  });
});

describe("blueprint source (#331, #241)", () => {
  it("is optional", () => {
    expect(blueprintSchema.parse(BASE).source).toBeUndefined();
  });

  it("round-trips a manual source", () => {
    const parsed = blueprintSchema.parse({ ...BASE, source: SOURCE });
    expect(parsed.source).toEqual(SOURCE);
  });

  it("requires a lowercase hex SHA-256 per document", () => {
    for (const sha256 of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      const bad = {
        ...SOURCE,
        documents: [{ ...SOURCE.documents[0], sha256 }],
      };
      expect(blueprintSourceSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("refuses an unknown format and unknown keys", () => {
    expect(
      blueprintSourceSchema.safeParse({ ...SOURCE, format: "scraped" }).success,
    ).toBe(false);
    expect(
      blueprintSourceSchema.safeParse({ ...SOURCE, extra: true }).success,
    ).toBe(false);
    expect(
      blueprintSourceSchema.safeParse({
        ...SOURCE,
        documents: [{ ...SOURCE.documents[0], body: "copied text" }],
      }).success,
    ).toBe(false);
  });

  it("refuses an unmapped entry without a locator", () => {
    expect(
      blueprintSourceSchema.safeParse({
        ...SOURCE,
        unmapped: [{ what: "x", documentId: "d1" }],
      }).success,
    ).toBe(false);
  });
});
