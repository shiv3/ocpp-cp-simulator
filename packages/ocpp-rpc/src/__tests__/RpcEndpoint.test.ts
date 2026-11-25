// Proof that an OCPP-J peer can be built from ocpp-rpc and ocpp alone (#978):
// a charging station and a CSMS endpoint wired back to back in memory. This
// file imports nothing from the simulator.
import { describe, expect, it } from "vitest";

import {
  OCPP16_RPC_DIALECT,
  OCPP21_RPC_DIALECT,
  OCPP2X_RPC_DIALECT,
  OCPPMessageType,
  RpcCallError,
  RpcClosedError,
  RpcEndpoint,
  RpcHandlerError,
  RpcInvalidResponseError,
  RpcTimeoutError,
  RpcUnsupportedMessageTypeError,
  ocppSchemaValidator,
  type RpcCallResultErrorFrame,
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

  it("answers InternalError when the answer it built cannot be encoded", async () => {
    const { cs, csms } = pair(OCPP16_RPC_DIALECT);
    const cyclic: Record<string, unknown> = { secret: "secret detail" };
    cyclic.self = cyclic;
    csms.endpoint.handle("Heartbeat", () => cyclic);
    csms.endpoint.handle("StatusNotification", () => {
      throw new RpcHandlerError("GenericError", "denied", cyclic);
    });
    const outcomes = ["Heartbeat", "StatusNotification"].map((action) =>
      cs.endpoint.call(action, {}).catch((e: unknown) => e),
    );
    await flush();
    expect([...csms.sent].sort()).toEqual([
      '[4,"cs-1","InternalError","Handler for Heartbeat failed",{}]',
      '[4,"cs-2","InternalError","Handler for StatusNotification failed",{}]',
    ]);
    for (const outcome of await Promise.all(outcomes)) {
      expect(outcome).toBeInstanceOf(RpcCallError);
    }
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

// The rules: docs/analyses/ocpp-protocol-stack.md#malformed-frames.
const MALFORMED_DIALECTS = [
  ["1.6", OCPP16_RPC_DIALECT, "GenericError"],
  ["2.0.1", OCPP2X_RPC_DIALECT, "RpcFrameworkError"],
  ["2.1", OCPP21_RPC_DIALECT, "RpcFrameworkError"],
] as const;

/** Frames answered with the RPC framework error: reason, frame, the id the
 *  answer carries and its description. */
const ANSWERED: readonly (readonly [string, string, string, string])[] = [
  ["not-json", "[2,", "-1", "Message is not valid JSON"],
  ["not-json", "", "-1", "Message is not valid JSON"],
  ["not-array", '{"a":1}', "-1", "Message is not a JSON array"],
  ["not-array", '"x"', "-1", "Message is not a JSON array"],
  ["invalid-message-type", "[]", "-1", "MessageTypeId could not be read"],
  [
    "invalid-message-type",
    '["2","m1","Heartbeat",{}]',
    "m1",
    "MessageTypeId could not be read",
  ],
  [
    "invalid-message-id",
    '[2,7,"Heartbeat",{}]',
    "-1",
    "MessageId could not be read",
  ],
  [
    "invalid-message-id",
    '[2,"","Heartbeat",{}]',
    "-1",
    "MessageId could not be read",
  ],
  ["invalid-action", '[2,"m1",42,{}]', "m1", "Action could not be read"],
  ["invalid-action", '[2,"m1","",{}]', "m1", "Action could not be read"],
  [
    "wrong-length",
    '[2,"m1","Heartbeat"]',
    "m1",
    "CALL does not have 4 elements",
  ],
  [
    "wrong-length",
    '[2,"m1","Heartbeat",{},{}]',
    "m1",
    "CALL does not have 4 elements",
  ],
];

/** Malformed frames no version answers: unknown message types (ignored) and
 *  malformed answers (a CALLERROR only answers a CALL). */
const UNANSWERED: readonly (readonly [string, string])[] = [
  ["unknown-message-type", '[7,"m1","X",{}]'],
  ["unknown-message-type", '[1,"m1",{}]'],
  ["unknown-message-type", "[7,42]"],
  ["unknown-message-type", '[2.5,"m1","Heartbeat",{}]'],
  ["wrong-length", '[3,"m1",{},{}]'],
  ["invalid-message-id", '[3,"",{}]'],
  ["invalid-message-id", "[3,7,{}]"],
  ["invalid-error", '[4,"m1",42,"no",{}]'],
  ["wrong-length", '[4,"m1","GenericError"]'],
];

describe("RpcEndpoint malformed and unexpected frames", () => {
  describe.each(MALFORMED_DIALECTS)("on %s", (_version, dialect, code) => {
    it.each(ANSWERED)(
      "answers %s %s with a CALLERROR",
      (reason, raw, messageId, description) => {
        const { cs } = pair(dialect);
        cs.endpoint.receive(raw);
        expect(cs.problems).toMatchObject([{ reason, raw }]);
        expect(cs.sent).toEqual([
          JSON.stringify([4, messageId, code, description, {}]),
        ]);
      },
    );

    it.each(UNANSWERED)(
      "reports %s %s to onProtocolError and sends nothing",
      (reason, raw) => {
        const { cs } = pair(dialect);
        cs.endpoint.receive(raw);
        expect(cs.problems).toMatchObject([{ reason, raw }]);
        expect(cs.sent).toEqual([]);
      },
    );
  });

  it.each([
    ["invalid-action", '[6,"m1","",{}]'],
    ["wrong-length", '[6,"m1","NotifyPeriodicEventStream"]'],
    ["invalid-error", '[5,"m1","FormatViolation",7]'],
    ["wrong-length", '[5,"m1","FormatViolation"]'],
  ])(
    "never answers a malformed 2.1 SEND or CALLRESULTERROR (%s %s)",
    (reason, raw) => {
      const { cs } = pair(OCPP21_RPC_DIALECT);
      cs.endpoint.receive(raw);
      expect(cs.problems).toMatchObject([{ reason, raw, messageId: "m1" }]);
      expect(cs.sent).toEqual([]);
    },
  );

  it("reports a reply it could not write after the malformed frame", () => {
    const problems: RpcProtocolProblem[] = [];
    const endpoint = new RpcEndpoint({
      dialect: OCPP2X_RPC_DIALECT,
      nextMessageId: () => "x",
      send: () => {
        throw new Error("socket closed");
      },
      onProtocolError: (problem) => problems.push(problem),
    });
    endpoint.receive("[2,");
    expect(problems).toEqual([
      { reason: "not-json", raw: "[2," },
      {
        reason: "reply-send-failed",
        raw: '[4,"-1","RpcFrameworkError","Message is not valid JSON",{}]',
        messageId: "-1",
      },
    ]);
  });

  it("does not answer a malformed frame after close()", () => {
    const { cs } = pair(OCPP16_RPC_DIALECT);
    cs.endpoint.close();
    cs.endpoint.receive("[2,");
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

const STREAM = {
  id: 1,
  pending: 0,
  basetime: CURRENT_TIME,
  data: [{ t: 0, v: "230" }],
};

/** Settles to "pending" while `promise` has not settled yet. */
const stateOf = (promise: Promise<unknown>): Promise<unknown> =>
  Promise.race([
    promise.then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ rejected: error }),
    ),
    flush().then(() => "pending"),
  ]);

describe("RpcEndpoint OCPP 2.1 SEND", () => {
  it("sends a SEND under the next message id while a CALL is in flight, and the peer never answers it", async () => {
    const { cs, csms } = pair(OCPP21_RPC_DIALECT, {
      validate: ocppSchemaValidator("2.1"),
    });
    const streamed: unknown[] = [];
    csms.endpoint.handleSend("NotifyPeriodicEventStream", (payload, ctx) => {
      streamed.push({ payload, ctx });
    });
    let answerHeartbeat: (value: unknown) => void = () => {};
    csms.endpoint.handle(
      "Heartbeat",
      () => new Promise((resolve) => (answerHeartbeat = resolve)),
    );

    const heartbeat = cs.endpoint.call("Heartbeat", {});
    const id = cs.endpoint.send("NotifyPeriodicEventStream", STREAM);
    await flush();
    answerHeartbeat({ currentTime: CURRENT_TIME });

    expect(id).toBe("cs-2");
    await expect(heartbeat).resolves.toEqual({ currentTime: CURRENT_TIME });
    expect(cs.sent).toEqual([
      '[2,"cs-1","Heartbeat",{}]',
      `[6,"cs-2","NotifyPeriodicEventStream",{"id":1,"pending":0,"basetime":"${CURRENT_TIME}","data":[{"t":0,"v":"230"}]}]`,
    ]);
    expect(streamed).toEqual([
      {
        payload: STREAM,
        ctx: { messageId: "cs-2", action: "NotifyPeriodicEventStream" },
      },
    ]);
    // Only the Heartbeat is answered (Part 4 §4.2.4).
    expect(csms.sent).toEqual([`[3,"cs-1",{"currentTime":"${CURRENT_TIME}"}]`]);
    expect([...cs.problems, ...csms.problems]).toEqual([]);
  });

  const failure = new Error("handler failed");
  it.each([
    ["unhandled-send", undefined, STREAM, undefined],
    [
      "invalid-send",
      () => {},
      { ...STREAM, data: [] },
      expect.objectContaining({ kind: expect.any(String) }),
    ],
    [
      "send-handler-failed",
      () => {
        throw failure;
      },
      STREAM,
      failure,
    ],
    [
      "send-handler-failed",
      async () => {
        await Promise.resolve();
        throw failure;
      },
      STREAM,
      failure,
    ],
  ] as const)(
    "never answers a SEND: %s is only reported",
    async (reason, handler, payload, cause) => {
      const { csms } = pair(OCPP21_RPC_DIALECT, {
        validate: ocppSchemaValidator("2.1"),
      });
      if (handler)
        csms.endpoint.handleSend("NotifyPeriodicEventStream", handler);
      const raw = JSON.stringify([
        6,
        "cs-9",
        "NotifyPeriodicEventStream",
        payload,
      ]);
      csms.endpoint.receive(raw);
      await flush();
      expect(csms.sent).toEqual([]);
      expect(csms.problems).toEqual([
        {
          reason,
          raw,
          messageId: "cs-9",
          ...(cause === undefined ? {} : { cause }),
        },
      ]);
    },
  );

  it("does not run a CALL handler for a SEND of the same action", async () => {
    const { csms } = pair(OCPP21_RPC_DIALECT);
    let ran = 0;
    csms.endpoint.handle("Heartbeat", () => {
      ran++;
      return {};
    });
    csms.endpoint.receive('[6,"cs-9","Heartbeat",{}]');
    await flush();
    expect(ran).toBe(0);
    expect(csms.sent).toEqual([]);
    expect(csms.problems).toMatchObject([{ reason: "unhandled-send" }]);
  });

  it("lets the error of the injected send through", () => {
    const failure = new Error("socket closed");
    const { cs } = pair(OCPP21_RPC_DIALECT, {
      send: () => {
        throw failure;
      },
    });
    expect(() => cs.endpoint.send("NotifyPeriodicEventStream", STREAM)).toThrow(
      failure,
    );
    expect(() =>
      cs.endpoint.sendCallResultError("csms-1", "FormatViolation", ""),
    ).toThrow(failure);
  });
});

describe("RpcEndpoint OCPP 2.1 CALLRESULTERROR", () => {
  it("reports an inbound CALLRESULTERROR and leaves a pending call with the same id alone", async () => {
    const reports: RpcCallResultErrorFrame[] = [];
    const { cs, csms } = pair(OCPP21_RPC_DIALECT, {
      onCallResultError: (frame) => reports.push(frame),
    });
    let answerHeartbeat: (value: unknown) => void = () => {};
    csms.endpoint.handle(
      "Heartbeat",
      () => new Promise((resolve) => (answerHeartbeat = resolve)),
    );
    const heartbeat = cs.endpoint.call("Heartbeat", {});
    await flush();

    // The id names a CALL the peer sent, from the peer's own id space; it
    // happens to equal the id of this side's pending call.
    cs.endpoint.receive('[5,"cs-1","FormatViolation","bad",{"x":1}]');

    expect(reports).toEqual([
      {
        kind: "callResultError",
        messageId: "cs-1",
        errorCode: "FormatViolation",
        errorDescription: "bad",
        errorDetails: { x: 1 },
      },
    ]);
    expect(await stateOf(heartbeat)).toBe("pending");
    answerHeartbeat({ currentTime: CURRENT_TIME });
    await expect(heartbeat).resolves.toEqual({ currentTime: CURRENT_TIME });
    expect(cs.problems).toEqual([]);
  });

  it("answers an invalid CALLRESULT only when the caller asks, with the code the rejection carries", async () => {
    const reports: RpcCallResultErrorFrame[] = [];
    const { cs, csms } = pair(OCPP21_RPC_DIALECT, {
      validate: ocppSchemaValidator("2.1"),
      onCallResultError: (frame) => reports.push(frame),
    });
    csms.endpoint.handle("Heartbeat", () => ({}));
    const error = await cs.endpoint
      .call("Heartbeat", {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcInvalidResponseError);
    // Nothing goes back on its own (decided on #1066).
    expect(cs.sent).toEqual(['[2,"cs-1","Heartbeat",{}]']);

    const invalid = error as RpcInvalidResponseError;
    cs.endpoint.sendCallResultError(
      invalid.messageId,
      invalid.errorCode,
      "currentTime is required",
    );
    await flush();

    expect(cs.sent.at(-1)).toBe(
      '[5,"cs-1","OccurrenceConstraintViolation","currentTime is required",{}]',
    );
    expect(reports).toEqual([
      {
        kind: "callResultError",
        messageId: "cs-1",
        errorCode: "OccurrenceConstraintViolation",
        errorDescription: "currentTime is required",
        errorDetails: {},
      },
    ]);
  });
});

describe("RpcEndpoint OCPP 2.1 message types elsewhere", () => {
  it.each([
    ["1.6", OCPP16_RPC_DIALECT],
    ["2.0.1", OCPP2X_RPC_DIALECT],
  ] as const)(
    "refuses to write a SEND or a CALLRESULTERROR on %s, before taking a message id",
    (_version, dialect) => {
      let ids = 0;
      const { cs } = pair(dialect, { nextMessageId: () => `id-${++ids}` });
      const send = () => cs.endpoint.send("NotifyPeriodicEventStream", STREAM);
      const callResultError = () =>
        cs.endpoint.sendCallResultError("csms-1", "FormatViolation", "");
      expect(send).toThrow(RpcUnsupportedMessageTypeError);
      expect(send).toThrow(
        expect.objectContaining({ messageType: OCPPMessageType.SEND }),
      );
      expect(callResultError).toThrow(
        expect.objectContaining({
          messageType: OCPPMessageType.CALLRESULTERROR,
        }),
      );
      expect(ids).toBe(0);
      expect(cs.sent).toEqual([]);
    },
  );

  it.each([
    ["1.6", '[6,"m1","NotifyPeriodicEventStream",{}]', OCPP16_RPC_DIALECT],
    ["1.6", '[5,"m1","FormatViolation","bad",{}]', OCPP16_RPC_DIALECT],
    ["2.0.1", '[6,"m1","NotifyPeriodicEventStream",{}]', OCPP2X_RPC_DIALECT],
    ["2.0.1", '[5,"m1","FormatViolation","bad",{}]', OCPP2X_RPC_DIALECT],
  ] as const)(
    "treats an inbound %s frame %s as an unknown message type, unanswered",
    async (_version, raw, dialect) => {
      const reports: RpcCallResultErrorFrame[] = [];
      const { cs } = pair(dialect, {
        onCallResultError: (frame) => reports.push(frame),
      });
      let ran = 0;
      cs.endpoint.handleSend("NotifyPeriodicEventStream", () => {
        ran++;
      });
      cs.endpoint.receive(raw);
      await flush();
      expect(cs.problems).toEqual([
        { reason: "unknown-message-type", raw, messageId: "m1" },
      ]);
      expect(cs.sent).toEqual([]);
      expect(ran).toBe(0);
      expect(reports).toEqual([]);
    },
  );

  it("refuses both after close() on 2.1", () => {
    const { cs } = pair(OCPP21_RPC_DIALECT);
    cs.endpoint.close("bye");
    expect(() => cs.endpoint.send("NotifyPeriodicEventStream", STREAM)).toThrow(
      RpcClosedError,
    );
    expect(() =>
      cs.endpoint.sendCallResultError("csms-1", "FormatViolation", ""),
    ).toThrow(RpcClosedError);
    expect(cs.sent).toEqual([]);
  });
});
