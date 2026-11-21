import { describe, expect, it } from "vitest";

import {
  actionValidatorV16,
  actionValidatorV201,
  actionValidatorV21,
} from "@ocpp-cp-simulator/ocpp/index";
import { buildV16CallHandlerRegistry } from "../../handlers/buildV16CallHandlerRegistry";
import type { OCPPAction } from "../../../../domain/types/OcppTypes";
import { buildV201InboundRegistry } from "../../v201/inboundRegistryV201";
import { buildV21InboundRegistry } from "../../v21/inboundRegistryV21";
import { getOcppCallCatalog } from "../ocppCallCatalog";

const JSON_VERSIONS = [
  {
    version: "OCPP-1.6J",
    validators: actionValidatorV16,
    isInbound: (action: string) =>
      buildV16CallHandlerRegistry().hasCallHandler(action as OCPPAction),
  },
  {
    version: "OCPP-2.0.1",
    validators: actionValidatorV201,
    isInbound: (action: string) => buildV201InboundRegistry().has(action),
  },
  {
    version: "OCPP-2.1",
    validators: actionValidatorV21,
    isInbound: (action: string) => buildV21InboundRegistry().has(action),
  },
] as const;

describe("getOcppCallCatalog", () => {
  it.each(["OCPP-1.2", "OCPP-1.5", "OCPP-1.6S"])(
    "has no catalog for the SOAP version %s",
    (version) => {
      expect(getOcppCallCatalog(version)).toBeNull();
    },
  );

  describe.each(JSON_VERSIONS)(
    "$version",
    ({ version, validators, isInbound }) => {
      const catalog = getOcppCallCatalog(version)!;

      it("lists only actions the version has a request schema for", () => {
        for (const action of catalog.actions) {
          expect(validators[action], action).toBeDefined();
        }
      });

      it("lists no action the station itself answers, except the two-way DataTransfer", () => {
        for (const action of catalog.actions) {
          if (action === "DataTransfer") continue;
          expect(isInbound(action), action).toBe(false);
        }
      });

      it("builds a schema-valid default payload for every listed action", () => {
        for (const action of catalog.actions) {
          const payload = catalog.defaultPayload(action);
          expect(catalog.validate(action, payload), action).toBeNull();
        }
      });

      it("reports a schema-invalid payload", () => {
        expect(catalog.validate("Heartbeat", { unexpected: 1 })).toMatch(
          /Heartbeat/,
        );
      });

      it("does not support a CSMS-initiated or unknown action", () => {
        expect(catalog.isSupported("Heartbeat")).toBe(true);
        expect(catalog.isSupported("Reset")).toBe(false);
        expect(catalog.isSupported("NoSuchAction")).toBe(false);
      });
    },
  );

  it("covers every station-initiated request of each JSON version", () => {
    // Everything with a request schema is either answered by the station
    // (inbound registry), sent by it as a CALL (`actions`) or, for 2.1's
    // NotifyPeriodicEventStream, sent as an OCPP-J SEND (`sendActions`, #1096).
    for (const { version, validators, isInbound } of JSON_VERSIONS) {
      const catalog = getOcppCallCatalog(version)!;
      const missing = Object.keys(validators).filter(
        (action) =>
          !isInbound(action) &&
          !catalog.isSupported(action) &&
          !catalog.isSendSupported(action),
      );
      expect(missing, version).toEqual([]);
    }
  });

  it("lists NotifyPeriodicEventStream as a 2.1 SEND, never as a CALL (#1096)", () => {
    const v21 = getOcppCallCatalog("OCPP-2.1")!;
    expect(v21.sendActions).toEqual(["NotifyPeriodicEventStream"]);
    expect(v21.isSendSupported("NotifyPeriodicEventStream")).toBe(true);
    expect(v21.isSupported("NotifyPeriodicEventStream")).toBe(false);
    expect(v21.isSendSupported("Heartbeat")).toBe(false);
    for (const version of ["OCPP-1.6J", "OCPP-2.0.1"]) {
      expect(getOcppCallCatalog(version)!.sendActions, version).toEqual([]);
    }
    for (const action of v21.sendActions) {
      const payload = v21.defaultPayload(action);
      expect(Object.keys(payload).length, action).toBeGreaterThan(0);
      expect(v21.validate(action, payload), action).toBeNull();
    }
  });

  it("adds the 2.1 station-initiated messages on top of 2.0.1", () => {
    const v201 = getOcppCallCatalog("OCPP-2.0.1")!;
    const v21 = getOcppCallCatalog("OCPP-2.1")!;
    expect(v201.isSupported("NotifySettlement")).toBe(false);
    expect(v21.isSupported("NotifySettlement")).toBe(true);
    for (const action of v201.actions) {
      expect(v21.isSupported(action), action).toBe(true);
    }
  });
});
