import { describe, expect, it } from "vitest";
import { FrameMeter, type FrameEvents } from "../frameMeter";

function setup() {
  const log: string[] = [];
  let now = 1000;
  const events: FrameEvents = {
    call: (a) => log.push(`call ${a}`),
    result: (a, ms, err) => log.push(`result ${a} ${ms}${err ? " error" : ""}`),
    csmsCall: (a) => log.push(`csms ${a}`),
  };
  const meter = new FrameMeter(events, () => now);
  return { meter, log, advance: (ms: number) => (now += ms) };
}

describe("FrameMeter", () => {
  it("times a CALL until its CALLRESULT", () => {
    const { meter, log, advance } = setup();
    meter.observe("sent", '[2,"a1","BootNotification",{"x":1}]');
    advance(7);
    meter.observe("received", '[3,"a1",{"status":"Accepted"}]');
    expect(log).toEqual(["call BootNotification", "result BootNotification 7"]);
  });

  it("marks a CALLERROR", () => {
    const { meter, log, advance } = setup();
    meter.observe("sent", '[2,"a2","Authorize",{}]');
    advance(3);
    meter.observe("received", '[4,"a2","NotImplemented","",{}]');
    expect(log).toEqual(["call Authorize", "result Authorize 3 error"]);
  });

  it("counts CSMS calls and ignores the station's own answers", () => {
    const { meter, log } = setup();
    meter.observe("received", '[2,"c1","GetConfiguration",{}]');
    meter.observe("sent", '[3,"c1",{"configurationKey":[]}]');
    expect(log).toEqual(["csms GetConfiguration"]);
  });

  it("ignores a result nobody asked for, and junk", () => {
    const { meter, log } = setup();
    meter.observe("received", '[3,"nope",{}]');
    meter.observe("sent", "not json");
    meter.observe("sent", "[]");
    expect(log).toEqual([]);
  });

  it("handles escaped quotes in a message id", () => {
    const { meter, log } = setup();
    meter.observe("sent", '[2,"a\\"b","Heartbeat",{}]');
    meter.observe("received", '[3,"a\\"b",{}]');
    expect(log).toHaveLength(2);
  });
});
