// The order in which the answers to an inbound CSMS CALL are tried
// (docs/concepts/call-precedence.md): inbound policy, response override,
// scenario rule (newest run first), code behavior (load order), default.
// Every pair is tested on the station, on 1.6 and 2.0.1, and the connector-less
// CALL (the case the design review asked about) too.
import { afterEach, describe, expect, test } from "bun:test";
import type {
  Behavior,
  BehaviorContext,
} from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";
import { answerTo, definition, startScenario, type Step } from "./runScenario";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});
const start = async (o: Parameters<typeof runBehavior>[0]) => {
  const r = await runBehavior(o);
  runs.push(r);
  return r;
};

const fw = {
  location: "http://fw.example/f.bin",
  retrieveDate: "2020-01-01T00:00:00.000Z",
};
// A CALL that names no connector, answered by the default as `{}` on 1.6 and 2.x.
const CALL = "UpdateFirmware";
const payload = (version: string): object =>
  version === "1.6"
    ? fw
    : {
        requestId: 1,
        firmware: { location: fw.location, retrieveDateTime: fw.retrieveDate },
      };

const codeAnswering = (id: string, code: string): Behavior => ({
  api: 1,
  id,
  onCall: {
    [CALL]: {
      mode: "replace",
      handle: () => ({ error: { code, description: id } }),
    },
  },
});
const scenarioAnswering = (
  code: string,
  idx = 0,
): ReturnType<typeof definition> =>
  definition(
    [
      {
        id: `t${idx}`,
        type: "csmsCallTrigger",
        data: { action: CALL, behavior: "replace" },
      } satisfies Step,
      {
        id: `r${idx}`,
        type: "callResponse",
        data: { kind: "error", errorCode: code, errorDescription: code },
      } satisfies Step,
    ],
    `s${idx}`,
  );

const codeOf = (run: BehaviorRun, id: string): string | undefined => {
  const a = answerTo(run, id);
  if (!a) return undefined;
  return a.kind === "error"
    ? (a.payload as { code: string }).code
    : `result:${JSON.stringify(a.payload)}`;
};

for (const version of ["1.6", "2.0.1"] as const) {
  describe(`precedence on ${version}`, () => {
    const ask = async (run: BehaviorRun): Promise<string | undefined> => {
      const id = run.callNoWait(CALL, payload(version));
      await run.settle();
      return codeOf(run, id);
    };

    test("default: nothing configured", async () => {
      const run = await start({ version });
      expect((await ask(run))?.startsWith("result:")).toBe(true);
    });

    test("code beats default", async () => {
      const run = await start({
        version,
        behaviors: [codeAnswering("c", "NotSupported")],
      });
      expect(await ask(run)).toBe("NotSupported");
    });

    test("code behaviors: the one loaded first wins", async () => {
      const run = await start({
        version,
        behaviors: [
          codeAnswering("first", "NotSupported"),
          codeAnswering("second", "FormatViolation"),
        ],
      });
      expect(await ask(run)).toBe("NotSupported");
    });

    test("a scenario beats code, though the code behavior was loaded first", async () => {
      const run = await start({
        version,
        behaviors: [codeAnswering("c", "NotSupported")],
      });
      startScenario(run, scenarioAnswering("SecurityError"));
      await run.settle();
      expect(await ask(run)).toBe("SecurityError");
    });

    test("the newest running scenario wins among scenarios", async () => {
      const run = await start({ version });
      startScenario(run, scenarioAnswering("NotSupported", 1));
      await run.settle();
      startScenario(run, scenarioAnswering("FormatViolation", 2));
      await run.settle();
      expect(await ask(run)).toBe("FormatViolation");
    });

    test("when the scenario ends, code answers again", async () => {
      const run = await start({
        version,
        behaviors: [codeAnswering("c", "NotSupported")],
      });
      const s = startScenario(run, scenarioAnswering("SecurityError"));
      await run.settle();
      expect(await ask(run)).toBe("SecurityError");
      await s.finished;
      expect(await ask(run)).toBe("NotSupported");
    });

    test("a response override beats a scenario and code", async () => {
      const run = await start({
        version,
        behaviors: [codeAnswering("c", "NotSupported")],
      });
      startScenario(run, scenarioAnswering("SecurityError"));
      await run.settle();
      run.cp.armResponseOverride(CALL, "Rejected");
      const id = run.callNoWait(CALL, payload(version));
      await run.settle();
      const a = answerTo(run, id);
      expect(a?.kind).toBe("result");
      expect((a?.payload as { status: string }).status).toBe("Rejected");
      // one-shot: the next CALL is the scenario's again
      expect(await ask(run)).toBe("SecurityError");
    });

    test("an inbound policy beats an override, a scenario and code", async () => {
      const run = await start({
        version,
        behaviors: [codeAnswering("c", "NotSupported")],
      });
      startScenario(run, scenarioAnswering("FormatViolation"));
      await run.settle();
      run.cp.armResponseOverride(CALL, "Rejected");
      run.cp.setInboundCallPolicy(CALL, {
        kind: "callerror",
        errorCode: "SecurityError",
        errorDescription: "policy",
      });
      expect(await ask(run)).toBe("SecurityError");
      // the override was not consumed by the policy
      run.cp.clearInboundCallPolicy(CALL);
      const id = run.callNoWait(CALL, payload(version));
      await run.settle();
      expect((answerTo(run, id)?.payload as { status: string }).status).toBe(
        "Rejected",
      );
    });
  });
}

describe("a CALL that names a connector", () => {
  test("a scenario armed for connector 2 still wins over code for connector 1's CALL (the kind ranks first)", async () => {
    const run = await start({
      version: "1.6",
      connectors: 2,
      behaviors: [
        {
          api: 1,
          id: "c",
          onCall: {
            ChangeAvailability: {
              mode: "replace",
              handle: () => ({
                error: { code: "NotSupported", description: "c" },
              }),
            },
          },
        },
      ],
    });
    startScenario(run, {
      ...definition([
        {
          id: "t",
          type: "csmsCallTrigger",
          data: { action: "ChangeAvailability", behavior: "replace" },
        },
        {
          id: "r",
          type: "callResponse",
          data: {
            kind: "error",
            errorCode: "SecurityError",
            errorDescription: "s",
          },
        },
      ]),
      targetId: 2,
    });
    await run.settle();
    const id = run.callNoWait("ChangeAvailability", {
      connectorId: 1,
      type: "Inoperative",
    });
    await run.settle();
    expect(codeOf(run, id)).toBe("SecurityError");
  });
});

// `_scenarioHandledConnectors` ("parking") belongs to the default behavior of
// RemoteStartTransaction: it is consulted only when the CALL reaches the
// default (or a code `extend` that runs it).
describe("parking of RemoteStartTransaction relates to the order", () => {
  const remoteStart = { connectorId: 1, idTag: "TAG" };
  const parked = (): ReturnType<typeof definition> =>
    definition([{ id: "w", type: "remoteStartTrigger", data: {} } as Step]);

  test("default path: a waiting remoteStartTrigger parks the start (no transaction), the scenario gets the request", async () => {
    const run = await start({ version: "1.6" });
    startScenario(run, parked());
    await run.settle();
    const id = run.callNoWait("RemoteStartTransaction", remoteStart);
    await run.settle();
    expect((answerTo(run, id)?.payload as { status: string }).status).toBe(
      "Accepted",
    );
    expect(run.callsOf("StartTransaction")).toHaveLength(0);
  });

  test("code extend runs the default, so parking applies after the code's handler", async () => {
    const seen: string[] = [];
    const run = await start({
      version: "1.6",
      behaviors: [
        {
          api: 1,
          id: "ext",
          onCall: {
            RemoteStartTransaction: {
              mode: "extend",
              handle: (req: unknown, ctx: BehaviorContext) => {
                seen.push("extend");
                return { response: ctx.defaultBehavior(req) };
              },
            },
          },
        } satisfies Behavior,
      ],
    });
    startScenario(run, parked());
    await run.settle();
    const id = run.callNoWait("RemoteStartTransaction", remoteStart);
    await run.settle();
    expect(seen).toEqual(["extend"]);
    expect((answerTo(run, id)?.payload as { status: string }).status).toBe(
      "Accepted",
    );
    expect(run.callsOf("StartTransaction")).toHaveLength(0);
  });

  test("a replace rule (code or scenario) takes the CALL before parking is looked at: the default never runs", async () => {
    const run = await start({
      version: "1.6",
      behaviors: [
        {
          api: 1,
          id: "rep",
          onCall: {
            RemoteStartTransaction: {
              mode: "replace",
              handle: (_r: unknown, ctx: BehaviorContext) => ({
                response: ctx.rejected("RemoteStartTransaction"),
              }),
            },
          },
        } satisfies Behavior,
      ],
    });
    startScenario(run, parked());
    await run.settle();
    const id = run.callNoWait("RemoteStartTransaction", remoteStart);
    await run.settle();
    expect(answerTo(run, id)?.kind).toBe("result");
    expect((answerTo(run, id)?.payload as { status: string }).status).toBe(
      "Rejected",
    );
  });
});
