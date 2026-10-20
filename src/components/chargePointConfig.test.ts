import { describe, expect, it } from "vitest";

import {
  SUPPORTED_OCPP_VERSIONS,
  isSoapVersion,
} from "../cp/domain/types/OcppVersion";
import {
  OCPP_VERSION_OPTIONS,
  protocolOf,
  versionForProtocol,
  versionsOfProtocol,
} from "./chargePointConfig";

describe("OCPP protocol / version helpers", () => {
  it("offers JSON 1.6, 2.0.1, 2.1 and SOAP 1.2, 1.5, 1.6, with bare version labels", () => {
    expect(OCPP_VERSION_OPTIONS.JSON).toEqual([
      { value: "OCPP-1.6J", label: "OCPP 1.6" },
      { value: "OCPP-2.0.1", label: "OCPP 2.0.1" },
      { value: "OCPP-2.1", label: "OCPP 2.1" },
    ]);
    expect(OCPP_VERSION_OPTIONS.SOAP).toEqual([
      { value: "OCPP-1.2", label: "OCPP 1.2" },
      { value: "OCPP-1.5", label: "OCPP 1.5" },
      { value: "OCPP-1.6S", label: "OCPP 1.6" },
    ]);
    expect(versionsOfProtocol("SOAP")).toBe(OCPP_VERSION_OPTIONS.SOAP);
  });

  it("covers every supported version exactly once", () => {
    const all = [...OCPP_VERSION_OPTIONS.JSON, ...OCPP_VERSION_OPTIONS.SOAP]
      .map((o) => o.value)
      .sort();
    expect(all).toEqual([...SUPPORTED_OCPP_VERSIONS].sort());
  });

  it("protocolOf agrees with isSoapVersion for every stored value", () => {
    for (const v of SUPPORTED_OCPP_VERSIONS) {
      expect(protocolOf(v)).toBe(isSoapVersion(v) ? "SOAP" : "JSON");
    }
    expect(protocolOf("OCPP-1.6S")).toBe("SOAP");
    expect(protocolOf("OCPP-1.6J")).toBe("JSON");
  });

  it("protocolOf treats an unknown stored value as JSON (the legacy fallback)", () => {
    expect(protocolOf("1.6J")).toBe("JSON");
    expect(protocolOf("")).toBe("JSON");
  });

  it("versionForProtocol keeps the same number when the other protocol has it", () => {
    expect(versionForProtocol("OCPP-1.6J", "SOAP")).toBe("OCPP-1.6S");
    expect(versionForProtocol("OCPP-1.6S", "JSON")).toBe("OCPP-1.6J");
  });

  it("versionForProtocol falls back to the protocol's first entry", () => {
    expect(versionForProtocol("OCPP-2.0.1", "SOAP")).toBe("OCPP-1.2");
    expect(versionForProtocol("OCPP-2.1", "SOAP")).toBe("OCPP-1.2");
    expect(versionForProtocol("OCPP-1.2", "JSON")).toBe("OCPP-1.6J");
    expect(versionForProtocol("OCPP-1.5", "JSON")).toBe("OCPP-1.6J");
  });

  it("versionForProtocol returns the version unchanged when it already belongs to the protocol", () => {
    expect(versionForProtocol("OCPP-2.0.1", "JSON")).toBe("OCPP-2.0.1");
    expect(versionForProtocol("OCPP-1.5", "SOAP")).toBe("OCPP-1.5");
  });
});
