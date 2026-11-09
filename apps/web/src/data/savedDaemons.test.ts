import { describe, expect, it } from "vitest";

import {
  addSavedDaemon,
  normalizeDaemonUrl,
  parseSavedDaemons,
  removeSavedDaemon,
} from "./savedDaemons";

describe("saved daemons (#619)", () => {
  it("normalizes addresses to an origin and rejects credentials", () => {
    expect(normalizeDaemonUrl("10.0.0.5:9700/")).toBe("http://10.0.0.5:9700");
    expect(normalizeDaemonUrl("https://a.example/x?y=1")).toBe(
      "https://a.example",
    );
    expect(normalizeDaemonUrl("http://u:p@a.example")).toBeNull();
    expect(normalizeDaemonUrl("ftp://a.example")).toBeNull();
    expect(normalizeDaemonUrl("  ")).toBeNull();
  });

  it("adds, de-duplicates and removes", () => {
    const first = addSavedDaemon([], "a.example:1", "A");
    if (!first.ok) throw new Error("expected ok");
    expect(first.list).toEqual([{ url: "http://a.example:1", name: "A" }]);
    expect(addSavedDaemon(first.list, "http://a.example:1/", "")).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(addSavedDaemon(first.list, "::", "")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(removeSavedDaemon(first.list, "http://a.example:1")).toEqual([]);
  });

  it("drops junk from stored data", () => {
    expect(parseSavedDaemons("not json")).toEqual([]);
    expect(
      parseSavedDaemons(
        JSON.stringify([
          { url: "http://a.example", name: "x" },
          { url: "http://a.example" },
          { url: 3 },
          null,
        ]),
      ),
    ).toEqual([{ url: "http://a.example", name: "x" }]);
  });
});
