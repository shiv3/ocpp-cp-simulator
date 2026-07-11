import { describe, expect, it } from "vitest";

import {
  OCPP_1_2,
  OCPP_1_5,
  OCPP_1_6,
  OCPP_1_6_SOAP,
  OCPP_2_0_1,
  OCPP_2_1,
  isSoapVersion,
  parseOcppVersion,
} from "../OcppVersion";

describe("OcppVersion", () => {
  describe("isSoapVersion", () => {
    it("returns true for OCPP-1.2", () => {
      expect(isSoapVersion(OCPP_1_2)).toBe(true);
    });

    it("returns true for OCPP-1.5", () => {
      expect(isSoapVersion(OCPP_1_5)).toBe(true);
    });

    it("returns true for OCPP-1.6S", () => {
      expect(isSoapVersion(OCPP_1_6_SOAP)).toBe(true);
    });

    it("returns false for OCPP-1.6J", () => {
      expect(isSoapVersion(OCPP_1_6)).toBe(false);
    });

    it("returns false for OCPP-2.0.1", () => {
      expect(isSoapVersion(OCPP_2_0_1)).toBe(false);
    });

    it("returns false for OCPP-2.1", () => {
      expect(isSoapVersion(OCPP_2_1)).toBe(false);
    });
  });

  describe("parseOcppVersion", () => {
    it("parses OCPP-1.2", () => {
      expect(parseOcppVersion("OCPP-1.2")).toBe(OCPP_1_2);
    });

    it("parses OCPP-1.5", () => {
      expect(parseOcppVersion("OCPP-1.5")).toBe(OCPP_1_5);
    });

    it("parses OCPP-1.6S", () => {
      expect(parseOcppVersion("OCPP-1.6S")).toBe(OCPP_1_6_SOAP);
    });

    it("defaults unknown versions to OCPP-1.6J", () => {
      expect(parseOcppVersion("OCPP-1.99")).toBe(OCPP_1_6);
    });

    it("returns OCPP-1.6J when passed null or undefined", () => {
      expect(parseOcppVersion(null)).toBe(OCPP_1_6);
      expect(parseOcppVersion(undefined)).toBe(OCPP_1_6);
    });
  });
});
