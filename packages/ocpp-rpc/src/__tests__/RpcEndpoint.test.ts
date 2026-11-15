// Proof that an OCPP-J peer can be built from ocpp-rpc and ocpp alone (#978):
// a charging station and a CSMS endpoint wired back to back in memory. This
// file imports nothing from the simulator.
import { describe, expect, it } from "vitest";

import {
  OCPP16_RPC_DIALECT,
  OCPP2X_RPC_DIALECT,
  RpcCallError,
  RpcClosedError,
  RpcEndpoint,
  RpcHandlerError,
  RpcInvalidResponseError,
  RpcTimeoutError,
  ocppSchemaValidator,
  type RpcClock,
  type RpcDialect,
  type RpcEndpointOptions,
  type RpcProtocolProblem,
} from "@ocpp-cp-simulator/ocpp-rpc/index";
import {
  OCPPErrorCodeV16,
  OCPPErrorCodeV201,
} from "@ocpp-cp-simulator/ocpp/index";

/** A clock that only moves when the test says so. */
class FakeClock implements RpcClock {
  private now = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.now + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(handle);
        timer.fn();
      }
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

interface Side {
  readonly endpoint: RpcEndpoint;
  readonly sent: string[];
  readonly problems: RpcProtocolProblem[];
}

/** A CS and a CSMS endpoint whose `send` feeds the other's `receive`. */
function pair(
  dialect: RpcDialect,
  options: Partial<RpcEndpointOptions> = {},
): { cs: Side; csms: Side; clock: FakeClock } {
  const clock = new FakeClock();
  const make = (prefix: string, peer: () => RpcEndpoint): Side => {
    const sent: string[] = [];
    const problems: RpcProtocolProblem[] = [];
    let n = 0;
    const endpoint = new RpcEndpoint({
      dialect,
      clock,
      callTimeoutMs: 1_000,
      nextMessageId: () => `${prefix}-${++n}`,
      send: (frame) => {
        sent.push(frame);
        queueMicrotask(() => peer().receive(frame));
      },
      onProtocolError: (problem) => problems.push(problem),
      ...options,
    });
    return { endpoint, sent, problems };
  };
  // eslint-disable-next-line prefer-const -- each side closes over the other
  let csms: Side;
  const cs = make("cs", () => csms.endpoint);
  csms = make("csms", () => cs.endpoint);
  return { cs, csms, clock };
}

/** Let the in-memory frames and the async handlers run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOOT_16 = { chargePointVendor: "Vendor", chargePointModel: "Model" };
const BOOT_201 = {
  chargingStation: { model: "Model", vendorName: "Vendor" },
  reason: "PowerUp",
};
const CURRENT_TIME = "2026-11-15T10:00:00.000Z";

describe("RpcEndpoint over an in-memory pipe", () => {
  it("exchanges an OCPP 1.6J BootNotification validated on both sides", async () => {
    const validate = ocppSchemaValidator("1.6");
    const { cs, csms } = pair(OCPP16_RPC_DIALECT, { validate });
    const seen: unknown[] = [];
    csms.endpoint.handle("BootNotification", (payload) => {
      seen.push(payload);
      return { status: "Accepted", currentTime: CURRENT_TIME, interval: 300 };
    });

    await expect(
      cs.endpoint.call("BootNotification", BOOT_16),
    ).resolves.toEqual({
      status: "Accepted",
      currentTime: CURRENT_TIME,
      interval: 300,
    });
    expect(seen).toEqual([BOOT_16]);
    expect(cs.sent).toEqual([
      '[2,"cs-1","BootNotification",{"chargePointVendor":"Vendor","chargePointModel":"Model"}]',
    ]);
    expect(csms.sent).toEqual([
      `[3,"cs-1",{"status":"Accepted","currentTime":"${CURRENT_TIME}","interval":300}]`,
    ]);
    expect([...cs.problems, ...csms.problems]).toEqual([]);
  });

  it("exchanges an OCPP 2.0.1 BootNotification validated on both sides", async () => {
    const { cs, csms } = pair(OCPP2X_RPC_DIALECT, {
      validate: ocppSchemaValidator("2.0.1"),
    });
    csms.endpoint.handle("BootNotification", () => ({
      currentTime: CURRENT_TIME,
      interval: 300,
      status: "Accepted",
    }));

    await expect(
      cs.endpoint.call("BootNotification", BOOT_201),
    ).resolves.toEqual({
      currentTime: CURRENT_TIME,
      interval: 300,
      status: "Accepted",
    });
  });

  it("lets the CSMS call the station too: the endpoint is role-agnostic", async () => {
    const { cs, csms } = pair(OCPP16_RPC_DIALECT, {
      validate: ocppSchemaValidator("1.6"),
    });
    cs.endpoint.handle("Reset", () => ({ status: "Accepted" }));
    await expect(
      csms.endpoint.call("Reset", { type: "Soft" }),
    ).resolves.toEqual({ status: "Accepted" });
  });
});

describe("RpcEndpoint CALLERROR paths", () => {
  it("answers NotImplemented for an action with no handler", async () => {
    const { cs, csms } = pair(OCPP16_RPC_DIALECT);
    const error = await cs.endpoint
      .call("DataTransfer", { vendorId: "v" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcCallError);
    expect(error).toMatchObject({
      action: "DataTransfer",
      messageId: "cs-1",
      errorCode: OCPPErrorCodeV16.NotImplemented,
      errorDetails: {},
    });
    expect(csms.sent).toEqual([
      '[4,"cs-1","NotImplemented","No handler for DataTransfer",{}]',
    ]);
  });

  it("answers an RpcHandlerError with its own code, description and details", async () => {
    const { cs, csms } = pair(OCPP2X_RPC_DIALECT);
    csms.endpoint.handle("Authorize", () => {
      throw new RpcHandlerError(OCPPErrorCodeV201.SecurityError, "denied", {
        why: "test",
      });
    });
    await expect(
      cs.endpoint.call("Authorize", { idToken: {} }),
    ).rejects.toMatchObject({
      errorCode: "SecurityError",
      errorDescription: "denied",
      errorDetails: { why: "test" },
    });
    expect(csms.sent).toEqual([
      '[4,"cs-1","SecurityError","denied",{"why":"test"}]',
    ]);
  });

  it("answers InternalError for any other throw, sync or async", async () => {
    const { cs, csms } = pair(OCPP16_RPC_DIALECT);
    csms.endpoint.handle("Heartbeat", () => {
      throw new Error("secret detail");
    });
    csms.endpoint.handle("StatusNotification", async () => {
      await Promise.resolve();
      throw new Error("secret detail");
    });
    for (const action of ["Heartbeat", "StatusNotification"]) {
      await expect(cs.endpoint.call(action, {})).rejects.toMatchObject({
        errorCode: OCPPErrorCodeV16.InternalError,
      });
    }
    expect(csms.sent.join("")).not.toContain("secret detail");
  });

  it.each([
    [
      "1.6",
      OCPP16_RPC_DIALECT,
      "FormationViolation",
      "OccurenceConstraintViolation",
    ],
    [
      "2.0.1",
      OCPP2X_RPC_DIALECT,
      "FormatViolation",
      "OccurrenceConstraintViolation",
    ],
  ] as const)(
    "answers an invalid %s request with the version's code and never runs the handler",
    async (version, dialect, formatCode, occurrenceCode) => {
      const { cs, csms } = pair(dialect, {
        validate: ocppSchemaValidator(version),
      });
      let ran = 0;
      csms.endpoint.handle("BootNotification", () => {
        ran++;
        return {};
      });
      const valid = version === "1.6" ? BOOT_16 : BOOT_201;

      await expect(
        cs.endpoint.call("BootNotification", { ...valid, bogus: 1 }),
      ).rejects.toMatchObject({ errorCode: formatCode });
      await expect(
        cs.endpoint.call("BootNotification", "not an object"),
      ).rejects.toMatchObject({ errorCode: formatCode });
      await expect(
        cs.endpoint.call("BootNotification", {}),
      ).rejects.toMatchObject({ errorCode: occurrenceCode });
      expect(ran).toBe(0);
    },
  );

  it("rejects a call whose CALLRESULT fails validation, without answering it", async () => {
    const { cs, csms } = pair(OCPP16_RPC_DIALECT, {
      validate: ocppSchemaValidator("1.6"),
    });
    csms.endpoint.handle("BootNotification", () => ({ status: "Maybe" }));
    const error = await cs.endpoint
      .call("BootNotification", BOOT_16)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcInvalidResponseError);
    expect(error).toMatchObject({
      action: "BootNotification",
      messageId: "cs-1",
      errorCode: "OccurenceConstraintViolation",
    });
    expect(cs.sent).toHaveLength(1);
  });
});

describe("RpcEndpoint timing and lifecycle", () => {
  it("rejects a call with RpcTimeoutError when the injected clock runs out", async () => {
    const { cs, clock } = pair(OCPP16_RPC_DIALECT, {
      // A peer that never answers.
      send: () => {},
    });
    let settled: unknown = "pending";
    const call = cs.endpoint.call("Heartbeat", {}).then(
      (v) => (settled = v),
      (e: unknown) => (settled = e),
    );
    clock.advance(999);
    await flush();
    expect(settled).toBe("pending");
    clock.advance(1);
    await call;
    expect(settled).toBeInstanceOf(RpcTimeoutError);
    expect(settled).toMatchObject({
      action: "Heartbeat",
      messageId: "cs-1",
      timeoutMs: 1_000,
    });
    expect(clock.pending).toBe(0);
  });

  it("reports a late answer to a timed-out call as unmatched", async () => {
    const { cs, clock } = pair(OCPP16_RPC_DIALECT, { send: () => {} });
    const call = cs.endpoint.call("Heartbeat", {}).catch(() => undefined);
    clock.advance(1_000);
    await call;
    cs.endpoint.receive('[3,"cs-1",{}]');
    expect(cs.problems).toEqual([
      {
        reason: "unmatched-response",
        raw: '[3,"cs-1",{}]',
        messageId: "cs-1",
      },
    ]);
  });

  it("clears the timer once the answer arrives", async () => {
    const { cs, csms, clock } = pair(OCPP16_RPC_DIALECT);
    csms.endpoint.handle("Heartbeat", () => ({ currentTime: CURRENT_TIME }));
    await cs.endpoint.call("Heartbeat", {});
    expect(clock.pending).toBe(0);
  });

  it("rejects pending and later calls once closed, and ignores frames", async () => {
    const { cs, clock } = pair(OCPP16_RPC_DIALECT, { send: () => {} });
    const pending = cs.endpoint.call("Heartbeat", {});
    cs.endpoint.close("socket gone");
    await expect(pending).rejects.toBeInstanceOf(RpcClosedError);
    await expect(pending).rejects.toThrow("socket gone");
    await expect(cs.endpoint.call("Heartbeat", {})).rejects.toBeInstanceOf(
      RpcClosedError,
    );
    expect(clock.pending).toBe(0);
    cs.endpoint.receive("garbage");
    expect(cs.problems).toEqual([]);
  });

  it("does not answer a call whose handler finishes after close", async () => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const endpoint = new RpcEndpoint({
      dialect: OCPP16_RPC_DIALECT,
      nextMessageId: () => "x",
      send: (frame) => sent.push(frame),
    });
    endpoint.handle(
      "Heartbeat",
      () => new Promise((resolve) => (release = () => resolve({}))),
    );
    endpoint.receive('[2,"in-1","Heartbeat",{}]');
    endpoint.close();
    release();
    await flush();
    expect(sent).toEqual([]);
  });

  it("rejects the call when send throws", async () => {
    const endpoint = new RpcEndpoint({
      dialect: OCPP16_RPC_DIALECT,
      nextMessageId: () => "x",
      send: () => {
        throw new Error("socket not open");
      },
    });
    await expect(endpoint.call("Heartbeat", {})).rejects.toThrow(
      "socket not open",
    );
  });

  it("reports an answer that send could not write", async () => {
    const problems: unknown[] = [];
    const endpoint = new RpcEndpoint({
      dialect: OCPP16_RPC_DIALECT,
      nextMessageId: () => "x",
      send: () => {
        throw new Error("socket not open");
      },
      onProtocolError: (problem) => problems.push(problem),
    });
    endpoint.handle("Heartbeat", () => ({ currentTime: "t" }));
    endpoint.receive('[2,"in-1","Heartbeat",{}]');
    await flush();
    expect(problems).toEqual([
      {
        reason: "reply-send-failed",
        raw: '[3,"in-1",{"currentTime":"t"}]',
        messageId: "in-1",
      },
    ]);
  });
});

describe("RpcEndpoint malformed and unexpected frames", () => {
  it.each([
    ["not-json", "[2,"],
    ["unknown-message-type", '[6,"m1",{}]'],
    ["wrong-length", '[2,"m1","Heartbeat"]'],
  ])("reports %s to onProtocolError and sends nothing", (reason, raw) => {
    const { cs } = pair(OCPP16_RPC_DIALECT);
    cs.endpoint.receive(raw);
    expect(cs.problems).toMatchObject([{ reason, raw }]);
    expect(cs.sent).toEqual([]);
  });

  it("reports a CALLERROR that answers no pending call", () => {
    const { cs } = pair(OCPP16_RPC_DIALECT);
    cs.endpoint.receive('[4,"zz","GenericError","no",{}]');
    expect(cs.problems).toEqual([
      {
        reason: "unmatched-response",
        raw: '[4,"zz","GenericError","no",{}]',
        messageId: "zz",
      },
    ]);
  });
});
