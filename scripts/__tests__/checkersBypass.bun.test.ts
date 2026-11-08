// The cheap bypass forms the two checks must see. What they cannot see (an
// alias passed through a function or property, a connector reached under
// another name through a parameter) is listed in docs/concepts/charger-engine.md,
// "Review".
import { describe, expect, it } from "bun:test";
import { scanSource as time } from "../check-direct-time";
import { scanSource as writer } from "../check-single-writer";

// Every snippet reads real time / randomness; the check should list it.
const TIME: Record<string, string> = {
  "Date()": "const s = Date();",
  "alias const d = Date": "const d = Date; d.now();",
  "destructured now": "const { now } = Date; now();",
  "globalThis.Date.now": "globalThis.Date.now();",
  "new globalThis.Date()": "new globalThis.Date();",
  "Date['now']": 'Date["now"]();',
  "new Date(Date) via undefined arg spread": "new Date(...[]);",
  "Math.random by reference": "[1].map(Math.random);",
  "globalThis.Math.random": "globalThis.Math.random();",
  "alias setTimeout": "const t = setTimeout; t(f, 1);",
  "setTimeout by reference": "defer(setTimeout);",
  "setTimeout.call": "setTimeout.call(null, f, 1);",
  setImmediate: "setImmediate(f);",
  "globalThis.crypto.randomUUID": "globalThis.crypto.randomUUID();",
  "import randomUUID":
    'import { randomUUID } from "node:crypto"; randomUUID();',
  "window.performance.now": "window.performance.now();",
  "timers/promises sleep":
    'import { setTimeout as sleep } from "node:timers/promises"; await sleep(1);',
  "process.hrtime": "process.hrtime();",
  "Bun.sleep": "await Bun.sleep(1);",
};
describe("check-direct-time sees", () => {
  for (const [name, src] of Object.entries(TIME)) {
    it(name, () => expect(time("x.ts", src).length).toBeGreaterThan(0));
  }
  it("(sound) the documented forms", () => {
    for (const src of [
      "Date.now()",
      "new Date()",
      "new Date",
      "(a = new Date()) => a",
      "window.setTimeout(f)",
      "globalThis.setInterval(f)",
      "self.clearTimeout(1)",
      "Math.random()",
      "crypto.randomUUID()",
      "performance.now()",
    ])
      expect(time("x.ts", src).length).toBe(1);
  });
});

const WRITES: Record<string, string> = {
  "other receiver name": "const c = cp.getConnector(1)!; c.status = s;",
  "element access": 'connector["status"] = s;',
  "Object.assign": "Object.assign(connector, { status: s });",
  "destructuring assignment": "[connector.status] = [s];",
  "object destructuring assignment": "({ s: connector.status } = o);",
  "for-of target": "for (connector.status of list) {}",
  delete: "delete connector.transaction;",
  "txn receiver": "txn.stopTime = t;",
  "Reflect.set": 'Reflect.set(connector, "status", s);',
  "Object.assign tx":
    "Object.assign(connector.transaction!, { meterStop: 1 });",
};
describe("check-single-writer accepted limits", () => {
  it("does not see a connector reached through a parameter or `this`", () => {
    expect(writer("x.ts", "function f(c: C) { c.status = s; }").length).toBe(0);
    expect(writer("x.ts", "class X { m() { this.status = s; } }").length).toBe(
      0,
    );
  });
});

describe("check-single-writer sees", () => {
  for (const [name, src] of Object.entries(WRITES)) {
    it(name, () => expect(writer("x.ts", src).length).toBeGreaterThan(0));
  }
  it("(sound) the documented forms", () => {
    for (const src of [
      "connector.status = s",
      "this.connector.status = s",
      "cp.getConnector(1)!.status = s",
      "connector!.transaction!.meterStop = 1",
      "(connector as any).status = s",
      "tx.id = 1",
      "tx.id++",
    ])
      expect(writer("x.ts", src).length).toBe(1);
  });
});
