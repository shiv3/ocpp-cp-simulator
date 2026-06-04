import { describe, it, expect, beforeEach } from "vitest";
import { LocalAuthListManager } from "../LocalAuthList";
import { Logger } from "../../../shared/Logger";

const LIMITS = { localAuthListMaxLength: 100, sendLocalListMaxLength: 50 };

function newManager(): LocalAuthListManager {
  return new LocalAuthListManager(new Logger());
}

describe("LocalAuthListManager", () => {
  let mgr: LocalAuthListManager;
  beforeEach(() => {
    mgr = newManager();
  });

  it("starts at version 0 with an empty list", () => {
    expect(mgr.getVersion()).toBe(0);
    expect(mgr.size()).toBe(0);
  });

  describe("Full update", () => {
    it("replaces the list and sets the version", () => {
      const status = mgr.applyFull(
        5,
        [
          { idTag: "A", idTagInfo: { status: "Accepted" } },
          { idTag: "B", idTagInfo: { status: "Blocked" } },
        ],
        LIMITS,
      );
      expect(status).toBe("Accepted");
      expect(mgr.getVersion()).toBe(5);
      expect(mgr.size()).toBe(2);
      expect(mgr.getEntry("A")?.status).toBe("Accepted");
      expect(mgr.getEntry("B")?.status).toBe("Blocked");
    });

    it("allows version to move backwards (spec permits)", () => {
      mgr.applyFull(10, [], LIMITS);
      const status = mgr.applyFull(3, [], LIMITS);
      expect(status).toBe("Accepted");
      expect(mgr.getVersion()).toBe(3);
    });

    it("rejects when entries exceed SendLocalListMaxLength", () => {
      const items = Array.from({ length: 51 }, (_, i) => ({
        idTag: `T${i}`,
        idTagInfo: { status: "Accepted" as const },
      }));
      const status = mgr.applyFull(1, items, LIMITS);
      expect(status).toBe("Failed");
      expect(mgr.getVersion()).toBe(0); // unchanged
    });

    it("drops entries without idTagInfo", () => {
      const status = mgr.applyFull(
        1,
        [
          { idTag: "A", idTagInfo: { status: "Accepted" } },
          { idTag: "B" }, // no info → omitted
        ],
        LIMITS,
      );
      expect(status).toBe("Accepted");
      expect(mgr.size()).toBe(1);
      expect(mgr.getEntry("A")).toBeDefined();
      expect(mgr.getEntry("B")).toBeUndefined();
    });
  });

  describe("Differential update", () => {
    beforeEach(() => {
      mgr.applyFull(
        1,
        [
          { idTag: "A", idTagInfo: { status: "Accepted" } },
          { idTag: "B", idTagInfo: { status: "Accepted" } },
        ],
        LIMITS,
      );
    });

    it("rejects when version is not strictly greater than current", () => {
      const status = mgr.applyDifferential(1, [], LIMITS);
      expect(status).toBe("VersionMismatch");
      expect(mgr.getVersion()).toBe(1);
    });

    it("upserts and deletes entries (omitted idTagInfo deletes)", () => {
      const status = mgr.applyDifferential(
        2,
        [
          { idTag: "A", idTagInfo: { status: "Blocked" } }, // update
          { idTag: "B" }, // delete
          { idTag: "C", idTagInfo: { status: "Accepted" } }, // insert
        ],
        LIMITS,
      );
      expect(status).toBe("Accepted");
      expect(mgr.getVersion()).toBe(2);
      expect(mgr.getEntry("A")?.status).toBe("Blocked");
      expect(mgr.getEntry("B")).toBeUndefined();
      expect(mgr.getEntry("C")?.status).toBe("Accepted");
    });

    it("rolls back when post-merge size exceeds LocalAuthListMaxLength", () => {
      const tightLimits = {
        localAuthListMaxLength: 2,
        sendLocalListMaxLength: 50,
      };
      const status = mgr.applyDifferential(
        2,
        [{ idTag: "C", idTagInfo: { status: "Accepted" } }],
        tightLimits,
      );
      expect(status).toBe("Failed");
      expect(mgr.getVersion()).toBe(1); // unchanged
      expect(mgr.getEntry("C")).toBeUndefined();
    });
  });

  it("dispose clears state", () => {
    mgr.applyFull(
      7,
      [{ idTag: "A", idTagInfo: { status: "Accepted" } }],
      LIMITS,
    );
    mgr.dispose();
    expect(mgr.size()).toBe(0);
    expect(mgr.getVersion()).toBe(0);
  });
});
