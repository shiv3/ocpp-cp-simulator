import { describe, expect, it } from "vitest";

import { buildUpsert } from "../upsert";

describe("buildUpsert", () => {
  it("derives placeholders, params and the update list from the entries", () => {
    const { sql, params } = buildUpsert(
      "t",
      [
        ["id", "a"],
        ["n", 1],
        ["created_at", "x"],
        ["v", null],
      ],
      ["id"],
      ["created_at"],
    );
    expect(sql).toBe(
      "INSERT INTO t (id, n, created_at, v) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET n = excluded.n, v = excluded.v",
    );
    expect(params).toEqual(["a", 1, "x", null]);
  });

  it("rejects duplicate columns and unknown key columns", () => {
    expect(() =>
      buildUpsert(
        "t",
        [
          ["a", 1],
          ["a", 2],
        ],
        ["a"],
      ),
    ).toThrow();
    expect(() => buildUpsert("t", [["a", 1]], ["b"])).toThrow();
  });
});
