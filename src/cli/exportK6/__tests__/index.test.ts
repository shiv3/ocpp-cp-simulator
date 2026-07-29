// src/cli/exportK6/__tests__/index.test.ts
// runtime/index.ts re-exports OcppChargePoint (via ocppClient.ts), which pulls
// in k6/websockets, k6/metrics, and k6/timers; those modules only exist inside
// the k6 runtime. Stub them out so resolveIdentity — a pure function with no
// k6 dependency of its own — can be exercised under vitest.
import { describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../runtime/index";

vi.mock("k6", () => ({ check: () => true }));
vi.mock("k6/websockets", () => ({ WebSocket: class {} }));
vi.mock("k6/metrics", () => ({
  Trend: class {
    add(): void {}
  },
  Counter: class {
    add(): void {}
  },
  Rate: class {
    add(): void {}
  },
}));
vi.mock("k6/timers", () => ({
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
}));
vi.mock("k6/data", () => ({ SharedArray: class {} }));

describe("resolveIdentity", () => {
  it("replaces every ${__VU} occurrence in the template, not just the first", () => {
    const identity = resolveIdentity(
      null,
      { CP_ID_TEMPLATE: "CP-${__VU}-${__VU}" },
      1,
    );
    expect(identity.cpId).toBe("CP-1-1");
  });

  it("defaults to CP-<vu> when no template is given", () => {
    expect(resolveIdentity(null, {}, 7).cpId).toBe("CP-7");
  });

  it("picks the identity file entry for out-of-range VUs by wrapping", () => {
    const identities = [{ cpId: "A" }, { cpId: "B" }];
    expect(resolveIdentity(identities, {}, 3).cpId).toBe("A");
  });

  it("carries a non-empty BASIC_AUTH_PASSWORD onto the resolved identity", () => {
    const identity = resolveIdentity(
      null,
      { CP_ID_TEMPLATE: "CP-${__VU}", BASIC_AUTH_PASSWORD: "secret" },
      2,
    );
    expect(identity).toEqual({ cpId: "CP-2", basicPassword: "secret" });
  });
});
