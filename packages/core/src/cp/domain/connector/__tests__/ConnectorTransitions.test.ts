import { describe, expect, it } from "vitest";

import { OCPPStatus } from "../../types/OcppTypes";
import {
  ALLOWED_CONNECTOR_STATUS_TRANSITIONS,
  isAllowedConnectorStatusTransition,
} from "../ConnectorTransitions";

/**
 * OCPP 1.6 edition 2, section 4.9: the cell codes of "the following table
 * describes which status transitions are possible", typed from the spec's
 * matrix (row letter = from, column number = to). Kept as codes on purpose, so
 * a reviewer can diff this list against the PDF.
 */
const COLUMN: Record<string, OCPPStatus> = {
  "1": OCPPStatus.Available,
  "2": OCPPStatus.Preparing,
  "3": OCPPStatus.Charging,
  "4": OCPPStatus.SuspendedEV,
  "5": OCPPStatus.SuspendedEVSE,
  "6": OCPPStatus.Finishing,
  "7": OCPPStatus.Reserved,
  "8": OCPPStatus.Unavailable,
  "9": OCPPStatus.Faulted,
};
const ROW: Record<string, OCPPStatus> = {
  A: OCPPStatus.Available,
  B: OCPPStatus.Preparing,
  C: OCPPStatus.Charging,
  D: OCPPStatus.SuspendedEV,
  E: OCPPStatus.SuspendedEVSE,
  F: OCPPStatus.Finishing,
  G: OCPPStatus.Reserved,
  H: OCPPStatus.Unavailable,
  I: OCPPStatus.Faulted,
};
const SPEC_CELLS = `
A2 A3 A4 A5 A7 A8 A9
B1 B3 B4 B5 B6 B9
C1 C4 C5 C6 C8 C9
D1 D3 D5 D6 D8 D9
E1 E3 E4 E6 E8 E9
F1 F2 F8 F9
G1 G2 G8 G9
H1 H2 H3 H4 H5 H9
I1 I2 I3 I4 I5 I6 I7 I8
`
  .trim()
  .split(/\s+/);

describe("ALLOWED_CONNECTOR_STATUS_TRANSITIONS", () => {
  it("is exactly the 53 transitions of the OCPP 1.6 section 4.9 table", () => {
    expect(SPEC_CELLS).toHaveLength(53);
    const expected = new Set(
      SPEC_CELLS.map((cell) => `${ROW[cell[0]]}>${COLUMN[cell[1]]}`),
    );
    const actual = new Set(
      Object.entries(ALLOWED_CONNECTOR_STATUS_TRANSITIONS).flatMap(
        ([from, targets]) => targets.map((to) => `${from}>${to}`),
      ),
    );
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("allows staying in a status, and refuses what the table leaves empty", () => {
    expect(
      isAllowedConnectorStatusTransition(
        OCPPStatus.Charging,
        OCPPStatus.Charging,
      ),
    ).toBe(true);
    // B8: not in the table.
    expect(
      isAllowedConnectorStatusTransition(
        OCPPStatus.Preparing,
        OCPPStatus.Unavailable,
      ),
    ).toBe(false);
    // A6: nothing is finished before it began.
    expect(
      isAllowedConnectorStatusTransition(
        OCPPStatus.Available,
        OCPPStatus.Finishing,
      ),
    ).toBe(false);
    // B6 (errata v3.0) and I1-I8.
    expect(
      isAllowedConnectorStatusTransition(
        OCPPStatus.Preparing,
        OCPPStatus.Finishing,
      ),
    ).toBe(true);
    expect(
      isAllowedConnectorStatusTransition(
        OCPPStatus.Faulted,
        OCPPStatus.Charging,
      ),
    ).toBe(true);
  });
});
