import { describe, expect, it } from "vitest";

import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "../../../data/interfaces/ChargePointService";
import {
  filterChargePoints,
  parseCpListFilters,
  parseCpListView,
  type CpListFilters,
  type CpListRow,
} from "./cpListFilters";

type RowConnector = CpListRow["connectors"][number];

function connector(
  id: number,
  overrides: Partial<RowConnector> = {},
): RowConnector {
  const base: ConnectorSnapshot = {
    id,
    status: OCPPStatus.Available,
    availability: "Operative",
    meterValue: 0,
    transactionId: null,
    soc: null,
    mode: "manual",
    autoResetToAvailable: false,
    autoMeterValueConfig: null,
    evSettings: null,
    chargingProfile: null,
    chargingProfiles: [],
    transactionStartTime: null,
    transactionTagId: null,
    transactionBatteryCapacityKwh: null,
  };
  return { ...base, hasRun: false, ...overrides };
}

function row(
  id: string,
  connectors: RowConnector[],
  overrides: Partial<Omit<CpListRow, "cp" | "connectors">> = {},
): CpListRow {
  const cp: ChargePointSnapshot = {
    id,
    status: OCPPStatus.Available,
    error: "",
    connectors,
  };
  return { cp, connected: true, ocppVersion: "1.6J", connectors, ...overrides };
}

const NONE: CpListFilters = parseCpListFilters(new URLSearchParams());

const rows = [
  row("CP-ALPHA", [
    connector(1),
    connector(2, { status: OCPPStatus.Charging, transactionId: 42 }),
  ]),
  row("cp-beta", [connector(1, { status: OCPPStatus.Faulted, hasRun: true })], {
    ocppVersion: "2.0.1",
  }),
  row("CP-GAMMA", [connector(3, { transactionId: 4207 })], {
    connected: false,
    ocppVersion: "1.6J",
  }),
];

const ids = (list: CpListRow[]) => list.map((r) => r.cp.id);
const apply = (patch: Partial<CpListFilters>) =>
  filterChargePoints(rows, { ...NONE, ...patch });

describe("parseCpListFilters", () => {
  it("reads every filter from the URL and defaults to no filter", () => {
    expect(NONE).toEqual({
      q: "",
      conn: "",
      tx: "",
      status: "",
      version: "",
      connected: false,
      scenario: false,
    });
    const parsed = parseCpListFilters(
      new URLSearchParams(
        "q=alp&conn=2&tx=42&status=Charging&version=2.0.1&connected=1&scenario=1",
      ),
    );
    expect(parsed).toEqual({
      q: "alp",
      conn: "2",
      tx: "42",
      status: OCPPStatus.Charging,
      version: "2.0.1",
      connected: true,
      scenario: true,
    });
  });

  it("drops a status that is not an OCPP status and a flag that is not 1", () => {
    const parsed = parseCpListFilters(
      new URLSearchParams("status=Sleeping&connected=yes&scenario=0"),
    );
    expect(parsed.status).toBe("");
    expect(parsed.connected).toBe(false);
    expect(parsed.scenario).toBe(false);
  });
});

describe("parseCpListView", () => {
  it("defaults to the hierarchy and ignores unknown values", () => {
    expect(parseCpListView(new URLSearchParams())).toBe("hierarchy");
    expect(parseCpListView(new URLSearchParams("view=cp"))).toBe("cp");
    expect(parseCpListView(new URLSearchParams("view=connectors"))).toBe(
      "connectors",
    );
    expect(parseCpListView(new URLSearchParams("view=grid"))).toBe("hierarchy");
  });
});

describe("filterChargePoints", () => {
  it("returns every row untouched without filters", () => {
    expect(apply({})).toEqual(rows);
  });

  it("q is a case-insensitive substring match on the charge point id", () => {
    expect(ids(apply({ q: "alp" }))).toEqual(["CP-ALPHA"]);
    expect(ids(apply({ q: "CP-" }))).toEqual([
      "CP-ALPHA",
      "cp-beta",
      "CP-GAMMA",
    ]);
    expect(ids(apply({ q: "BETA" }))).toEqual(["cp-beta"]);
    expect(apply({ q: "zzz" })).toEqual([]);
  });

  it("conn '#2' and '2' match the connector with that number, not a transaction id", () => {
    for (const conn of ["#2", "2", " # 2 "]) {
      const result = apply({ conn });
      expect(ids(result)).toEqual(["CP-ALPHA"]);
      expect(result[0].connectors.map((c) => c.id)).toEqual([2]);
    }
    expect(ids(apply({ conn: "#1" }))).toEqual(["CP-ALPHA", "cp-beta"]);
    expect(ids(apply({ conn: "3" }))).toEqual(["CP-GAMMA"]);
    expect(apply({ conn: "#5" })).toEqual([]);
  });

  it("conn that is only a prefix does not filter; anything else matches nothing", () => {
    expect(apply({ conn: "#" })).toEqual(rows);
    expect(apply({ conn: "abc" })).toEqual([]);
    // The old combined form is gone: no compatibility shim.
    expect(apply({ conn: "Tx 42" })).toEqual([]);
  });

  it("tx matches a transaction id containing the digits, not a connector number", () => {
    for (const tx of ["42", "#42", "# 42"]) {
      const result = apply({ tx });
      expect(ids(result)).toEqual(["CP-ALPHA", "CP-GAMMA"]);
      expect(result[0].connectors.map((c) => c.id)).toEqual([2]);
      expect(result[1].connectors.map((c) => c.id)).toEqual([3]);
    }
    expect(ids(apply({ tx: "4207" }))).toEqual(["CP-GAMMA"]);
    // Connector 1 and 2 exist, but no transaction id contains 1.
    expect(apply({ tx: "1" })).toEqual([]);
  });

  it("tx that is only a prefix does not filter; anything else matches nothing", () => {
    expect(apply({ tx: "#" })).toEqual(rows);
    expect(apply({ tx: "x" })).toEqual([]);
  });

  it("conn and tx combine with AND on the same connector", () => {
    const result = apply({ conn: "2", tx: "42" });
    expect(ids(result)).toEqual(["CP-ALPHA"]);
    expect(result[0].connectors.map((c) => c.id)).toEqual([2]);
    expect(ids(apply({ conn: "3", tx: "4207" }))).toEqual(["CP-GAMMA"]);
    expect(apply({ conn: "1", tx: "42" })).toEqual([]);
  });

  it("status matches the connector status and narrows the connectors", () => {
    const result = apply({ status: OCPPStatus.Charging });
    expect(ids(result)).toEqual(["CP-ALPHA"]);
    expect(result[0].connectors.map((c) => c.id)).toEqual([2]);
  });

  it("version matches the charge point's OCPP version", () => {
    expect(ids(apply({ version: "2.0.1" }))).toEqual(["cp-beta"]);
    expect(ids(apply({ version: "1.6J" }))).toEqual(["CP-ALPHA", "CP-GAMMA"]);
  });

  it("connected keeps only connected charge points, with all their connectors", () => {
    const result = apply({ connected: true });
    expect(ids(result)).toEqual(["CP-ALPHA", "cp-beta"]);
    expect(result[0].connectors).toHaveLength(2);
  });

  it("scenario keeps only connectors with an active run", () => {
    const result = apply({ scenario: true });
    expect(ids(result)).toEqual(["cp-beta"]);
    expect(result[0].connectors.map((c) => c.id)).toEqual([1]);
  });

  it("a connector-level filter hides the charge points without a match, even ones without connectors", () => {
    const withEmpty = [...rows, row("CP-EMPTY", [])];
    expect(
      ids(
        filterChargePoints(withEmpty, { ...NONE, status: OCPPStatus.Faulted }),
      ),
    ).toEqual(["cp-beta"]);
    // ... but a charge-point-level filter keeps it.
    expect(ids(filterChargePoints(withEmpty, { ...NONE, q: "empty" }))).toEqual(
      ["CP-EMPTY"],
    );
    expect(ids(filterChargePoints(withEmpty, NONE))).toContain("CP-EMPTY");
  });

  it("combines filters with AND, so the counter inputs follow the narrowed rows", () => {
    const result = apply({ connected: true, status: OCPPStatus.Available });
    expect(ids(result)).toEqual(["CP-ALPHA"]);
    const connectors = result.reduce((n, r) => n + r.connectors.length, 0);
    expect([result.length, connectors]).toEqual([1, 1]);
    const all = apply({});
    expect(all.reduce((n, r) => n + r.connectors.length, 0)).toBe(4);
  });

  it("does not mutate the rows it is given", () => {
    const before = JSON.stringify(rows);
    apply({ status: OCPPStatus.Charging });
    expect(JSON.stringify(rows)).toBe(before);
  });
});
