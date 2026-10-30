import { describe, expect, it } from "vitest";

import { eventToWire } from "../events";
import { METHODS } from "../methods";

// Locks in the protocol-review fixes (B-1 url-cred strip, B-2 scenario bound).

describe("eventToWire url-credential stripping (B-1)", () => {
  it("strips embedded user:pass@ from URL-shaped string values", () => {
    const wire = eventToWire({
      event: "log",
      data: { endpoint: "ws://user:pass@host:9000/ocpp", note: "ok" },
    });
    const json = JSON.stringify(wire);
    expect(json).not.toContain("pass@");
    expect(json).toContain("ws://host:9000/ocpp");
    expect(json).toContain("ok");
  });
});

describe("scenario object size bound (B-2)", () => {
  // Well-shaped so these exercise the SIZE bound only: `load_scenario` also
  // requires the fields the runtime keys on, and a shapeless fixture would
  // fail for that reason instead.
  const scenario = (extra: Record<string, unknown> = {}) => ({
    id: "s1",
    name: "S1",
    targetType: "connector",
    nodes: [{ id: "n1" }],
    edges: [],
    ...extra,
  });

  it("rejects a scenario object over 256 KB", () => {
    expect(
      METHODS.load_scenario.params.safeParse({
        connector: 1,
        scenario: scenario({ blob: "x".repeat(300_000) }),
      }).success,
    ).toBe(false);
  });

  it("accepts a normal scenario object", () => {
    expect(
      METHODS.load_scenario.params.safeParse({
        connector: 1,
        scenario: scenario(),
      }).success,
    ).toBe(true);
  });

  it("rejects a scenario missing the fields the runtime keys on", () => {
    for (const field of ["id", "name", "targetType", "nodes", "edges"]) {
      const def = scenario() as Record<string, unknown>;
      delete def[field];
      expect(
        METHODS.load_scenario.params.safeParse({ connector: 1, scenario: def })
          .success,
      ).toBe(false);
    }
  });

  it("bounds generic object params (set_ev_settings) at 64 KB", () => {
    const big = { blob: "x".repeat(70_000) };
    expect(
      METHODS.set_ev_settings.params.safeParse({ connector: 1, settings: big })
        .success,
    ).toBe(false);
  });
});

describe("sign_certificate csr bound (#456)", () => {
  // SignCertificateRequest.csr is string[0..5500] in 1.6 (whitepaper),
  // 2.0.1 and 2.1.
  it("accepts a CSR of 5500 characters and refuses one of 5501", () => {
    const params = METHODS.sign_certificate.params;
    expect(params.safeParse({ csr: "c".repeat(5500) }).success).toBe(true);
    expect(params.safeParse({ csr: "c".repeat(5501) }).success).toBe(false);
  });
});

describe("get_15118_ev_certificate bounds (#537)", () => {
  const params = METHODS.get_15118_ev_certificate.params;
  const valid = {
    iso15118SchemaVersion: "urn:iso:15118:2:2013:MsgDef",
    action: "Install",
    exiRequest: "AAAA",
  };

  it("takes the 2.1 bounds; a station on 2.0.1 applies its own schema", () => {
    // exiRequest is string[0..11000] on 2.1 (5600 on 2.0.1),
    // iso15118SchemaVersion string[0..50], prioritizedEMAIDs 0..8 of
    // identifierString[0..255].
    expect(
      params.safeParse({ ...valid, exiRequest: "A".repeat(11000) }).success,
    ).toBe(true);
    expect(
      params.safeParse({ ...valid, exiRequest: "A".repeat(11004) }).success,
    ).toBe(false);
    expect(
      params.safeParse({ ...valid, iso15118SchemaVersion: "v".repeat(51) })
        .success,
    ).toBe(false);
    expect(
      params.safeParse({ ...valid, prioritizedEMAIDs: Array(9).fill("E") })
        .success,
    ).toBe(false);
    expect(
      params.safeParse({ ...valid, prioritizedEMAIDs: ["E".repeat(256)] })
        .success,
    ).toBe(false);
    expect(
      params.safeParse({ ...valid, maximumContractCertificateChains: -1 })
        .success,
    ).toBe(false);
    expect(params.safeParse({ ...valid, action: "Delete" }).success).toBe(
      false,
    );
  });

  it.each(["AA==", "AAA=", "AAAA", "ab+/"])("accepts base64 %s", (exi) => {
    expect(params.safeParse({ ...valid, exiRequest: exi }).success).toBe(true);
  });

  it.each(["AAA", "AA=A", "A===", "AA AA", "AA==\n", "é"])(
    "refuses %j, not base64",
    (exi) => {
      expect(params.safeParse({ ...valid, exiRequest: exi }).success).toBe(
        false,
      );
    },
  );

  it("checks a long non-base64 input in linear time", () => {
    const started = performance.now();
    params.safeParse({ ...valid, exiRequest: `${"A".repeat(10999)}=` });
    expect(performance.now() - started).toBeLessThan(200);
  });
});
