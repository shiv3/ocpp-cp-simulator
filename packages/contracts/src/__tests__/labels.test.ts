import { describe, expect, it } from "vitest";

import {
  LABEL_KEY_MAX,
  LABEL_VALUE_MAX,
  LABELS_MAX_ENTRIES,
  labelKeySchema,
  labelsSchema,
  matchesLabelSelector,
  normalizeLabels,
} from "../labels";

describe("labelKeySchema (#446)", () => {
  it.each(["site", "a", "env-1", "team.ops", "example.com/tier", "A_b"])(
    "accepts %s",
    (key) => {
      expect(labelKeySchema.safeParse(key).success).toBe(true);
    },
  );

  it.each(["", "-site", "site-", ".a", "a/", "has space", "é", "a=b", "a:b"])(
    "refuses %j",
    (key) => {
      expect(labelKeySchema.safeParse(key).success).toBe(false);
    },
  );

  it("caps the key length", () => {
    expect(labelKeySchema.safeParse("k".repeat(LABEL_KEY_MAX)).success).toBe(
      true,
    );
    expect(
      labelKeySchema.safeParse("k".repeat(LABEL_KEY_MAX + 1)).success,
    ).toBe(false);
  });
});

describe("labelsSchema (#446)", () => {
  it("accepts an empty map and an empty value", () => {
    expect(labelsSchema.safeParse({}).success).toBe(true);
    expect(labelsSchema.safeParse({ site: "" }).success).toBe(true);
  });

  it("refuses a non-string value and an over-long value", () => {
    expect(labelsSchema.safeParse({ site: 1 }).success).toBe(false);
    expect(
      labelsSchema.safeParse({ site: "v".repeat(LABEL_VALUE_MAX + 1) }).success,
    ).toBe(false);
  });

  it("refuses an invalid key", () => {
    expect(labelsSchema.safeParse({ "bad key": "x" }).success).toBe(false);
  });

  it(`caps the map at ${LABELS_MAX_ENTRIES} entries`, () => {
    const map = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(labelsSchema.safeParse(map(LABELS_MAX_ENTRIES)).success).toBe(true);
    expect(labelsSchema.safeParse(map(LABELS_MAX_ENTRIES + 1)).success).toBe(
      false,
    );
  });
});

describe("matchesLabelSelector (#446)", () => {
  const labels = { site: "oberkirch-01", env: "lab", note: "" };

  it("matches everything when the selector is absent or empty", () => {
    expect(matchesLabelSelector(labels, undefined)).toBe(true);
    expect(matchesLabelSelector(labels, {})).toBe(true);
    expect(matchesLabelSelector(undefined, {})).toBe(true);
  });

  it("requires every selector pair to match exactly", () => {
    expect(matchesLabelSelector(labels, { site: "oberkirch-01" })).toBe(true);
    expect(
      matchesLabelSelector(labels, { site: "oberkirch-01", env: "lab" }),
    ).toBe(true);
    expect(
      matchesLabelSelector(labels, { site: "oberkirch-01", env: "prod" }),
    ).toBe(false);
    expect(matchesLabelSelector(labels, { site: "Oberkirch-01" })).toBe(false);
  });

  it("distinguishes an empty value from a missing key", () => {
    expect(matchesLabelSelector(labels, { note: "" })).toBe(true);
    expect(matchesLabelSelector(labels, { owner: "" })).toBe(false);
  });

  it("never matches a non-empty selector on a CP without labels", () => {
    expect(matchesLabelSelector(undefined, { site: "x" })).toBe(false);
  });

  it("refuses a __proto__ key, so a parsed map cannot reach the prototype", () => {
    expect(labelKeySchema.safeParse("__proto__").success).toBe(false);
  });
});

describe("normalizeLabels (#446)", () => {
  it("folds an empty map into undefined and copies a non-empty one", () => {
    expect(normalizeLabels(undefined)).toBeUndefined();
    expect(normalizeLabels({})).toBeUndefined();
    const labels = { site: "x" };
    const normalized = normalizeLabels(labels);
    expect(normalized).toEqual(labels);
    expect(normalized).not.toBe(labels);
  });
});
