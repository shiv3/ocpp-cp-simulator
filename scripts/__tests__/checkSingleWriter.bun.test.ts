import { describe, expect, it } from "bun:test";

import {
  ENGINE_DIR,
  evaluate,
  scanSource,
  scanTree,
  EXEMPTIONS,
  type Exemption,
  type Write,
} from "../check-single-writer";

const fields = (text: string) => scanSource("x.ts", text).map((w) => w.field);

describe("scanSource", () => {
  it("finds assignments to the guarded fields of a connector", () => {
    expect(
      fields(`
        connector.status = OCPPStatus.Available;
        this.connector.availability = "Inoperative";
        cp.getConnector(1)!.scheduledAvailability = null;
        connectors.get(id)!.currentErrorCode = "NoError";
        (connector).errorInfo = null;
        connector.vendorErrorCode ??= "x";
      `),
    ).toEqual([
      "status",
      "availability",
      "scheduledAvailability",
      "currentErrorCode",
      "errorInfo",
      "vendorErrorCode",
    ]);
  });

  it("ignores reads, comparisons, other fields and other receivers", () => {
    expect(
      fields(`
        const s = connector.status;
        if (connector.status === OCPPStatus.Available) {}
        connector.transaction = null;
        this.status = status;
        server.status = 1;
        const o = { status: 1 };
      `),
    ).toEqual([]);
  });
});

describe("evaluate", () => {
  const w = (line: number): Write => ({ field: "status", line });

  it("allows the engine and reports every other file", () => {
    const report = evaluate(
      new Map([
        [`${ENGINE_DIR}behaviors/x.ts`, [w(1)]],
        ["packages/core/src/cp/domain/charge-point/ChargePoint.ts", [w(7)]],
      ]),
      [],
    );
    expect(report.violations).toEqual([
      {
        file: "packages/core/src/cp/domain/charge-point/ChargePoint.ts",
        lines: [7],
        allowed: 0,
      },
    ]);
  });

  it("lets an exemption cover its count and flags a stale one", () => {
    const exemption: Exemption = { file: "a.ts", count: 2, reason: "test" };
    expect(evaluate(new Map([["a.ts", [w(1), w(2)]]]), [exemption])).toEqual({
      violations: [],
      stale: [],
    });
    expect(
      evaluate(new Map([["a.ts", [w(1), w(2), w(3)]]]), [exemption]).violations,
    ).toHaveLength(1);
    expect(evaluate(new Map([["a.ts", [w(1)]]]), [exemption]).stale).toEqual([
      { exemption, found: 1 },
    ]);
  });
});

describe("the repository", () => {
  it("has no write to connector state outside the engine", () => {
    const report = evaluate(scanTree(), EXEMPTIONS);
    expect(report.violations).toEqual([]);
    expect(report.stale).toEqual([]);
  });
});
