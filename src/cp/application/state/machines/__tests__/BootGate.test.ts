import { describe, it, expect } from "vitest";
import { BootGate } from "../BootGate";
import { OCPPAction } from "../../../../domain/types/OcppTypes";

describe("BootGate", () => {
  describe("status getter/setter", () => {
    it("starts in Idle status", () => {
      const gate = new BootGate();
      expect(gate.status).toEqual({ status: "Idle" });
    });

    it("allows setting to Accepted", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.status).toEqual({ status: "Accepted" });
    });

    it("allows setting to Pending", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.status).toEqual({ status: "Pending" });
    });

    it("allows setting to Rejected with retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      expect(gate.status).toEqual({ status: "Rejected", retryAfter });
    });
  });

  describe("isCallAllowed in Idle state", () => {
    it("allows BootNotification", () => {
      const gate = new BootGate();
      expect(gate.isCallAllowed(OCPPAction.BootNotification)).toBe(true);
    });

    it("blocks Authorize", () => {
      const gate = new BootGate();
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(false);
    });

    it("blocks Heartbeat", () => {
      const gate = new BootGate();
      expect(gate.isCallAllowed(OCPPAction.Heartbeat)).toBe(false);
    });

    it("blocks StatusNotification", () => {
      const gate = new BootGate();
      expect(gate.isCallAllowed(OCPPAction.StatusNotification)).toBe(false);
    });

    it("blocks StartTransaction", () => {
      const gate = new BootGate();
      expect(gate.isCallAllowed(OCPPAction.StartTransaction)).toBe(false);
    });

    it("blocks StopTransaction", () => {
      const gate = new BootGate();
      expect(gate.isCallAllowed(OCPPAction.StopTransaction)).toBe(false);
    });

    it("blocks MeterValues", () => {
      const gate = new BootGate();
      expect(gate.isCallAllowed(OCPPAction.MeterValues)).toBe(false);
    });
  });

  describe("isCallAllowed in Accepted state", () => {
    it("allows BootNotification", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.BootNotification)).toBe(true);
    });

    it("allows Authorize", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(true);
    });

    it("allows Heartbeat", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.Heartbeat)).toBe(true);
    });

    it("allows StatusNotification", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.StatusNotification)).toBe(true);
    });

    it("allows StartTransaction", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.StartTransaction)).toBe(true);
    });

    it("allows StopTransaction", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.StopTransaction)).toBe(true);
    });

    it("allows MeterValues", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.MeterValues)).toBe(true);
    });

    it("allows DataTransfer", () => {
      const gate = new BootGate();
      gate.set({ status: "Accepted" });
      expect(gate.isCallAllowed(OCPPAction.DataTransfer)).toBe(true);
    });
  });

  describe("isCallAllowed in Pending state", () => {
    it("allows BootNotification", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.BootNotification)).toBe(true);
    });

    it("blocks Authorize", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(false);
    });

    it("blocks Heartbeat", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.Heartbeat)).toBe(false);
    });

    it("blocks StatusNotification", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.StatusNotification)).toBe(false);
    });

    it("blocks StartTransaction", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.StartTransaction)).toBe(false);
    });

    it("blocks StopTransaction", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.StopTransaction)).toBe(false);
    });

    it("blocks MeterValues", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.MeterValues)).toBe(false);
    });

    it("blocks DataTransfer", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.isCallAllowed(OCPPAction.DataTransfer)).toBe(false);
    });
  });

  describe("isCallAllowed in Rejected state", () => {
    it("allows BootNotification", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      expect(gate.isCallAllowed(OCPPAction.BootNotification)).toBe(true);
    });

    it("blocks Authorize before retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      const beforeRetry = new Date("2026-07-11T11:59:59Z");
      expect(gate.isCallAllowed(OCPPAction.Authorize, beforeRetry)).toBe(false);
    });

    it("allows Authorize at retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      const atRetry = new Date("2026-07-11T12:00:00Z");
      expect(gate.isCallAllowed(OCPPAction.Authorize, atRetry)).toBe(true);
    });

    it("allows Authorize after retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      const afterRetry = new Date("2026-07-11T12:00:01Z");
      expect(gate.isCallAllowed(OCPPAction.Authorize, afterRetry)).toBe(true);
    });

    it("blocks Heartbeat before retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      const beforeRetry = new Date("2026-07-11T11:59:59Z");
      expect(gate.isCallAllowed(OCPPAction.Heartbeat, beforeRetry)).toBe(false);
    });

    it("allows Heartbeat after retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      const afterRetry = new Date("2026-07-11T12:00:01Z");
      expect(gate.isCallAllowed(OCPPAction.Heartbeat, afterRetry)).toBe(true);
    });

    it("blocks StatusNotification before retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      const beforeRetry = new Date("2026-07-11T11:59:59Z");
      expect(
        gate.isCallAllowed(OCPPAction.StatusNotification, beforeRetry),
      ).toBe(false);
    });

    it("allows StatusNotification after retryAfter", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      const afterRetry = new Date("2026-07-11T12:00:01Z");
      expect(
        gate.isCallAllowed(OCPPAction.StatusNotification, afterRetry),
      ).toBe(true);
    });
  });

  describe("state transitions", () => {
    it("transitions from Idle → Accepted", () => {
      const gate = new BootGate();
      expect(gate.status.status).toBe("Idle");
      gate.set({ status: "Accepted" });
      expect(gate.status.status).toBe("Accepted");
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(true);
    });

    it("transitions from Idle → Pending", () => {
      const gate = new BootGate();
      expect(gate.status.status).toBe("Idle");
      gate.set({ status: "Pending" });
      expect(gate.status.status).toBe("Pending");
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(false);
    });

    it("transitions from Idle → Rejected", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      expect(gate.status.status).toBe("Rejected");
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(false);
    });

    it("transitions from Pending → Accepted", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      expect(gate.status.status).toBe("Pending");
      gate.set({ status: "Accepted" });
      expect(gate.status.status).toBe("Accepted");
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(true);
    });

    it("transitions from Pending → Rejected", () => {
      const gate = new BootGate();
      gate.set({ status: "Pending" });
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      expect(gate.status.status).toBe("Rejected");
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(false);
    });

    it("transitions from Rejected → Accepted", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      gate.set({ status: "Accepted" });
      expect(gate.status.status).toBe("Accepted");
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(true);
    });

    it("transitions from Rejected → Pending", () => {
      const gate = new BootGate();
      const retryAfter = new Date("2026-07-11T12:00:00Z");
      gate.set({ status: "Rejected", retryAfter });
      gate.set({ status: "Pending" });
      expect(gate.status.status).toBe("Pending");
      expect(gate.isCallAllowed(OCPPAction.Authorize)).toBe(false);
    });
  });
});
