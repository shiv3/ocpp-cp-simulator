import { describe, expect, it } from "vitest";
import type { ModemSnapshot } from "../CellularModem";
import {
  cellularPoliciesProblem,
  resolveCellularLink,
  type CellularPolicySet,
} from "../cellularLink";

const sim = (over: Partial<NonNullable<ModemSnapshot["sim"]>> = {}) => ({
  simId: "cp-sim-1",
  iccid: "8944501234567890123",
  operator: "acme",
  subscription: "active" as const,
  ...over,
});
const snap = (over: Partial<ModemSnapshot> = {}): ModemSnapshot => ({
  slot: "inserted",
  reporting: "iccid-and-imsi",
  networkInterface: "cellular",
  sim: sim(),
  ...over,
});

describe("resolveCellularLink (#930)", () => {
  it("is null for a station without a modem model", () => {
    expect(resolveCellularLink(null, {})).toBeNull();
  });

  it("is available on an active cellular SIM", () => {
    expect(resolveCellularLink(snap(), {})).toMatchObject({
      available: true,
      reasons: [],
      upstreamBytesPerSecond: null,
    });
  });

  it("reports each outage reason", () => {
    expect(
      resolveCellularLink(snap({ sim: sim({ subscription: "suspended" }) }), {})
        ?.reasons,
    ).toEqual(["subscription_suspended"]);
    expect(
      resolveCellularLink(snap({ slot: "empty", sim: null }), {})?.reasons,
    ).toEqual(["sim_missing"]);
    expect(
      resolveCellularLink(snap({ slot: "no_modem", sim: null }), {})?.reasons,
    ).toEqual(["modem_absent"]);
  });

  it("reasons are independent: a suspended card under a blocking policy has both", () => {
    const policies: CellularPolicySet = {
      b: { match: { operator: "acme" }, service: "blocked" },
    };
    expect(
      resolveCellularLink(
        snap({ sim: sim({ subscription: "suspended" }) }),
        policies,
      )?.reasons,
    ).toEqual(["subscription_suspended", "sim_network_blocked"]);
  });

  it("an online policy never reactivates a suspended subscription or undoes a block", () => {
    const suspended = snap({ sim: sim({ subscription: "suspended" }) });
    expect(
      resolveCellularLink(suspended, {
        up: { match: { simId: "cp-sim-1" }, service: "online" },
      })?.available,
    ).toBe(false);
    expect(
      resolveCellularLink(snap(), {
        a: { match: { simId: "cp-sim-1" }, service: "online" },
        b: { match: { operator: "acme" }, service: "blocked" },
      })?.available,
    ).toBe(false);
  });

  it("selects by simId, ICCID or operator and reports the selection source", () => {
    const policies: CellularPolicySet = {
      "1-sim": { match: { simId: "cp-sim-1" }, upstreamBytesPerSecond: 500 },
      "2-iccid": { match: { iccid: "8944501234567890123" } },
      "3-op": { match: { operator: "acme" } },
      "4-other": { match: { operator: "other" }, service: "blocked" },
      "5-off": {
        match: { operator: "acme" },
        service: "blocked",
        enabled: false,
      },
    };
    expect(resolveCellularLink(snap(), policies)?.policies).toEqual([
      { id: "1-sim", by: "simId", service: "online" },
      { id: "2-iccid", by: "iccid", service: "online" },
      { id: "3-op", by: "operator", service: "online" },
    ]);
  });

  it("takes the lowest cap per direction and ignores caps off the cellular path", () => {
    const policies: CellularPolicySet = {
      a: {
        match: { operator: "acme" },
        upstreamBytesPerSecond: 2000,
        downstreamBytesPerSecond: 9000,
      },
      b: {
        match: { iccid: "8944501234567890123" },
        upstreamBytesPerSecond: 800,
      },
    };
    expect(resolveCellularLink(snap(), policies)).toMatchObject({
      upstreamBytesPerSecond: 800,
      downstreamBytesPerSecond: 9000,
    });
    expect(
      resolveCellularLink(snap({ networkInterface: "wifi" }), policies),
    ).toMatchObject({
      available: true,
      upstreamBytesPerSecond: null,
      downstreamBytesPerSecond: null,
    });
  });

  it("does not depend on policy order", () => {
    const a: CellularPolicySet = {
      x: { match: { operator: "acme" }, upstreamBytesPerSecond: 100 },
      y: { match: { iccid: "8944501234567890123" }, service: "blocked" },
    };
    const b: CellularPolicySet = { y: a.y, x: a.x };
    expect(resolveCellularLink(snap(), a)).toEqual(
      resolveCellularLink(snap(), b),
    );
  });
});

describe("cellularPoliciesProblem", () => {
  it("accepts a valid set and the empty set", () => {
    expect(cellularPoliciesProblem({})).toBeNull();
    expect(
      cellularPoliciesProblem({
        p1: {
          match: { iccid: "123" },
          service: "blocked",
          upstreamBytesPerSecond: 10,
        },
      }),
    ).toBeNull();
  });

  it.each([
    [[], /object/],
    [{ "bad id": { match: { iccid: "1" } } }, /policy id/],
    [{ p: { match: {} } }, /exactly one/],
    [{ p: { match: { iccid: "1", operator: "a" } } }, /exactly one/],
    [{ p: { match: { cpId: "x" } } }, /unknown field/],
    [{ p: { match: { iccid: "1" }, service: "off" } }, /service/],
    [
      { p: { match: { iccid: "1" }, upstreamBytesPerSecond: 0 } },
      /upstreamBytesPerSecond/,
    ],
    [
      { p: { match: { iccid: "1" }, downstreamBytesPerSecond: 1.5 } },
      /downstreamBytesPerSecond/,
    ],
    [{ p: { match: { iccid: "1" }, extra: 1 } }, /unknown field/],
  ])("rejects %j", (value, message) => {
    expect(cellularPoliciesProblem(value)).toMatch(message);
  });
});
