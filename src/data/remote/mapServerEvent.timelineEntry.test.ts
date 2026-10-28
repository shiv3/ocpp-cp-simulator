import { describe, expect, it } from "vitest";

import { mapServerEventToChargePointEvent } from "./RemoteChargePointService";

const entry = {
  seq: 3,
  timestamp: "2026-10-27T15:21:42.000Z",
  kind: "network_fault_injected",
  cpId: "CP-1",
  incidentId: "inc-1",
  summary: "Network fault injected by rule cut",
  data: { ruleId: "cut" },
};

describe("mapServerEventToChargePointEvent timeline_entry (#448)", () => {
  it("maps the daemon event to timeline-entry", () => {
    expect(
      mapServerEventToChargePointEvent({
        event: "timeline_entry",
        data: entry,
      } as never),
    ).toEqual({ type: "timeline-entry", entry });
  });

  it("drops an entry without a seq: it cannot be placed", () => {
    const { seq: _seq, ...withoutSeq } = entry;
    expect(
      mapServerEventToChargePointEvent({
        event: "timeline_entry",
        data: withoutSeq,
      } as never),
    ).toBeNull();
  });
});
