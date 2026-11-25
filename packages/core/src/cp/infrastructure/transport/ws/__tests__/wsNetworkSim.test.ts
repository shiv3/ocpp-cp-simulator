import { describe, expect, it } from "vitest";
import { LogLevel, Logger } from "../../../../shared/Logger";
import { dispatchIncomingFrame } from "../wsNetworkSim";

/**
 * #1060: the simulator's inbound path answers a malformed frame with the
 * CALLERROR OCPP-J asks for, per version, and never hands it to the message
 * handler. The rules: docs/analyses/ocpp-protocol-stack.md#malformed-frames.
 */

function dispatch(raw: string, ocppVersion: string) {
  const replies: string[] = [];
  const handled: unknown[][] = [];
  const intercepted: unknown[][] = [];
  dispatchIncomingFrame(raw, {
    logger: new Logger(LogLevel.ERROR),
    ocppVersion,
    intercept: (frame) => {
      intercepted.push(frame);
      return false;
    },
    handler: () => (type, id, action, payload) =>
      handled.push([type, id, action, payload]),
    reply: (frame) => replies.push(frame),
  });
  return { replies, handled, intercepted };
}

const VERSIONS = [
  ["OCPP-1.6J", "GenericError"],
  ["OCPP-2.0.1", "RpcFrameworkError"],
  ["OCPP-2.1", "RpcFrameworkError"],
] as const;

describe.each(VERSIONS)("dispatchIncomingFrame on %s", (version, code) => {
  it.each([
    ["this is not json", "-1", "Message is not valid JSON"],
    ['{"a":1}', "-1", "Message is not a JSON array"],
    ['["2","m1","Heartbeat",{}]', "m1", "MessageTypeId could not be read"],
    ['[2,7,"Reset",{}]', "-1", "MessageId could not be read"],
    ['[2,"m1",42,{}]', "m1", "Action could not be read"],
    ['[2,"m1","Reset"]', "m1", "CALL does not have 4 elements"],
    ['[2,"m1","Reset",{},{}]', "m1", "CALL does not have 4 elements"],
  ])("answers %s with a CALLERROR", (raw, messageId, description) => {
    const { replies, handled } = dispatch(raw, version);
    expect(replies).toEqual([
      JSON.stringify([4, messageId, code, description, {}]),
    ]);
    expect(handled).toEqual([]);
  });

  it.each([
    '[7,"m1","X",{}]',
    '[1,"m1",{}]',
    '[3,"m1",{},{}]',
    '[3,"",{}]',
    '[4,"m1",42,"no",{}]',
  ])("ignores %s without an answer", (raw) => {
    const { replies, handled } = dispatch(raw, version);
    expect(replies).toEqual([]);
    expect(handled).toEqual([]);
  });

  it("hands a valid CALL to the handler and answers nothing itself", () => {
    const { replies, handled } = dispatch('[2,"m1","Reset",{}]', version);
    expect(replies).toEqual([]);
    expect(handled).toEqual([[2, "m1", "Reset", {}]]);
  });

  it("still offers a malformed 3- to 5-element array to the interceptor", () => {
    const { intercepted } = dispatch('[2,"m1","Reset"]', version);
    expect(intercepted).toEqual([[2, "m1", "Reset"]]);
  });

  it("logs an interceptor that throws and does not let it escape", () => {
    const logger = new Logger(LogLevel.ERROR);
    const replies: string[] = [];
    const handled: unknown[][] = [];
    expect(() =>
      dispatchIncomingFrame('[2,"m1","Reset",{}]', {
        logger,
        ocppVersion: version,
        intercept: () => {
          throw new Error("interceptor broke");
        },
        handler: () => (type, id, action, payload) =>
          handled.push([type, id, action, payload]),
        reply: (frame) => replies.push(frame),
      }),
    ).not.toThrow();
    expect(logger.getLogs().join("\n")).toContain(
      "Error parsing message: Error: interceptor broke",
    );
    expect(replies).toEqual([]);
    expect(handled).toEqual([]);
  });
});

describe("dispatchIncomingFrame and the OCPP 2.1 message types", () => {
  it.each(["OCPP-1.6J", "OCPP-2.0.1"])(
    "ignores SEND and CALLRESULTERROR on %s, unknown types there",
    (version) => {
      for (const raw of [
        '[6,"m1","NotifyPeriodicEventStream",{}]',
        '[5,"m1","FormatViolation","bad",{}]',
      ]) {
        const { replies, handled } = dispatch(raw, version);
        expect(replies).toEqual([]);
        expect(handled).toEqual([]);
      }
    },
  );

  it.each([
    '[6,"m1","",{}]',
    '[6,"m1","NotifyPeriodicEventStream"]',
    '[5,"m1","FormatViolation",7]',
  ])("never answers a malformed 2.1 SEND or CALLRESULTERROR %s", (raw) => {
    const { replies, handled } = dispatch(raw, "OCPP-2.1");
    expect(replies).toEqual([]);
    expect(handled).toEqual([]);
  });

  it("still hands a 2.1 SEND to the handler, unanswered", () => {
    const raw = '[6,"m1","NotifyPeriodicEventStream",{}]';
    const { replies, handled } = dispatch(raw, "OCPP-2.1");
    expect(replies).toEqual([]);
    expect(handled).toEqual([[6, "m1", "NotifyPeriodicEventStream", {}]]);
  });
});
