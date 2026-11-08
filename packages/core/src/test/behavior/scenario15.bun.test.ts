// Scenario schema 1.5 (#566): csmsCallTrigger behavior "replace", callResponse,
// $from, useBehavior, and the rows of the runtime contract table in
// docs/concepts/charger-engine.md.
import { afterEach, describe, expect, test } from "bun:test";
import { runBehavior, type BehaviorRun } from "./runBehavior";
import { answerTo, definition, startScenario, type Step } from "./runScenario";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const fw16 = {
  location: "http://fw.example/f.bin",
  retrieveDate: "2020-01-01T00:00:00.000Z",
};

const replaceTrigger = (
  action: string,
  extra: Record<string, unknown> = {},
): Step => ({
  id: `trigger-${action}`,
  type: "csmsCallTrigger",
  data: { action, behavior: "replace", ...extra },
});
const respond = (data: Record<string, unknown>, id = "respond"): Step => ({
  id,
  type: "callResponse",
  data,
});
const delay = (seconds: number, id = `delay-${seconds}`): Step => ({
  id,
  type: "delay",
  data: { delaySeconds: seconds },
});
const send = (action: string, payload: object, id?: string): Step => ({
  id: id ?? `send-${action}-${JSON.stringify(payload).length}`,
  type: "ocppCall",
  data: { action, payload },
});

const statuses = (r: BehaviorRun): unknown[] =>
  r
    .callsOf("FirmwareStatusNotification")
    .map((f) => (f.payload as { status: string }).status);

describe("csmsCallTrigger behavior replace + callResponse", () => {
  test("the scenario answers, then sends its own notifications; the default train does not run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("UpdateFirmware"),
        respond({ kind: "result", payload: {} }),
        send("FirmwareStatusNotification", { status: "Downloading" }, "d"),
        delay(3),
        send("FirmwareStatusNotification", { status: "Installed" }, "i"),
      ]),
    );
    await run.settle();
    const id = run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    expect(answerTo(run, id)).toEqual({ kind: "result", payload: {} });
    expect(statuses(run)).toEqual(["Downloading"]);
    await run.advance(2999);
    expect(statuses(run)).toEqual(["Downloading"]);
    await run.advance(1);
    expect(statuses(run)).toEqual(["Downloading", "Installed"]);
    await scenario.finished;
    expect(scenario.state()).toBe("completed");
    // Nothing from the default train, ever.
    await run.advance(30_000);
    expect(statuses(run)).toEqual(["Downloading", "Installed"]);
  });

  test("observe stays the default: the station answers and the train runs", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        {
          id: "t",
          type: "csmsCallTrigger",
          data: { action: "UpdateFirmware" },
        },
      ]),
    );
    await run.settle();
    await run.call("UpdateFirmware", fw16);
    await run.advance(8000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("an error answer and silence", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        replaceTrigger("Reset"),
        respond({
          kind: "error",
          errorCode: "NotSupported",
          errorDescription: "no",
        }),
      ]),
    );
    await run.settle();
    const a = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    expect(answerTo(run, a)).toMatchObject({
      kind: "error",
      payload: { code: "NotSupported", description: "no" },
    });

    const quiet = await runBehavior({ version: "1.6" });
    startScenario(
      quiet,
      definition([replaceTrigger("Reset"), respond({ kind: "none" })]),
    );
    await quiet.settle();
    const b = quiet.callNoWait("Reset", { type: "Soft" });
    await quiet.settle();
    expect(answerTo(quiet, b)).toBeUndefined();
    await quiet.dispose();
  });

  test("an answer that breaks the response schema fails the run, skipValidation sends it", async () => {
    run = await runBehavior({ version: "1.6" });
    const bad = startScenario(
      run,
      definition([
        replaceTrigger("Reset"),
        respond({ kind: "result", payload: { status: "Maybe" } }),
      ]),
    );
    await run.settle();
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    expect(bad.state()).toBe("error");
    expect(bad.error()).toContain("breaks its schema");
    // The run ended with the CALL unanswered: InternalError.
    expect(answerTo(run, id)).toMatchObject({
      kind: "error",
      payload: { code: "InternalError" },
    });

    const forced = await runBehavior({ version: "1.6" });
    startScenario(
      forced,
      definition([
        replaceTrigger("Reset"),
        respond({
          kind: "result",
          payload: { status: "Maybe" },
          skipValidation: true,
        }),
      ]),
    );
    await forced.settle();
    const id2 = forced.callNoWait("Reset", { type: "Soft" });
    await forced.settle();
    expect(answerTo(forced, id2)).toEqual({
      kind: "result",
      payload: { status: "Maybe" },
    });
    await forced.dispose();
  });
});

describe("$from", () => {
  test("a whole value reads the CALL of the branch, in callResponse and ocppCall (2.0.1)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("UpdateFirmware"),
        respond({ kind: "result", payload: { status: "Accepted" } }),
        send(
          "FirmwareStatusNotification",
          {
            status: "Downloading",
            requestId: { $from: "call.payload.requestId" },
          },
          "n",
        ),
      ]),
    );
    await run.settle();
    run.callNoWait("UpdateFirmware", {
      requestId: 77,
      firmware: {
        location: "http://fw.example/f.bin",
        retrieveDateTime: "2020-01-01T00:00:00.000Z",
      },
    });
    await run.settle();
    expect(scenario.state()).toBe("completed");
    expect(run.callsOf("FirmwareStatusNotification")[0].payload).toEqual({
      status: "Downloading",
      requestId: 77,
    });
  });

  test("a path that names nothing fails the run", async () => {
    run = await runBehavior({ version: "2.0.1" });
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("UpdateFirmware"),
        respond({ kind: "result", payload: { status: "Accepted" } }),
        send(
          "FirmwareStatusNotification",
          { status: "Downloading", requestId: { $from: "call.payload.nope" } },
          "n",
        ),
      ]),
    );
    await run.settle();
    run.callNoWait("UpdateFirmware", { requestId: 1, firmware: {} });
    await run.settle();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toContain('$from "call.payload.nope"');
    expect(run.callsOf("FirmwareStatusNotification")).toHaveLength(0);
  });

  test("$from with no CALL taken fails the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        send("FirmwareStatusNotification", {
          status: { $from: "call.payload.status" },
        }),
      ]),
    );
    await run.settle();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toContain("needs a CALL");
  });
});

describe("runtime contract", () => {
  test("disconnect before answering: abandoned, NoResponse, the run fails", async () => {
    run = await runBehavior({ version: "1.6" });
    const completions: Array<{
      messageId: string | undefined;
      outcome: string;
    }> = [];
    run.cp.events.on("incomingCallCompleted", (c) =>
      completions.push({ messageId: c.messageId, outcome: c.outcome }),
    );
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("Reset"),
        delay(10),
        respond({ kind: "result", payload: { status: "Accepted" } }),
      ]),
    );
    await run.settle();
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    run.cp.disconnect();
    await run.advance(10_000);
    expect(completions).toEqual([{ messageId: id, outcome: "NoResponse" }]);
    expect(answerTo(run, id)).toBeUndefined();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toContain("not delivered");
  });

  test("run ends unanswered: CALLERROR InternalError; kind none is the way to stay silent", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(run, definition([replaceTrigger("Reset")]));
    await run.settle();
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    expect(scenario.state()).toBe("completed");
    expect(answerTo(run, id)).toMatchObject({
      kind: "error",
      payload: { code: "InternalError" },
    });
  });

  test("run stopped while the CALL is open: CALLERROR InternalError", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([replaceTrigger("Reset"), delay(600)]),
    );
    await run.settle();
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    expect(answerTo(run, id)).toBeUndefined();
    await scenario.stop();
    await run.settle();
    expect(answerTo(run, id)).toMatchObject({
      kind: "error",
      payload: { code: "InternalError" },
    });
  });

  test("answer after reconnect: not sent, settles stale, the run fails", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("Reset"),
        delay(5),
        respond({ kind: "result", payload: { status: "Accepted" } }),
      ]),
    );
    await run.settle();
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    run.cp.disconnect();
    await run.settle();
    run.cp.connect();
    await run.csms.waitForConnection();
    await run.advance(6000);
    expect(answerTo(run, id)).toBeUndefined();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toContain("stale");
  });

  test("time before answering: the simulator never times the CALL out", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("Reset"),
        delay(3600),
        respond({ kind: "result", payload: { status: "Accepted" } }),
      ]),
    );
    await run.settle();
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.advance(3_599_000);
    expect(answerTo(run, id)).toBeUndefined();
    expect(scenario.state()).toBe("running");
    await run.advance(1000);
    expect(answerTo(run, id)).toEqual({
      kind: "result",
      payload: { status: "Accepted" },
    });
  });

  test("callResponse without an exchange fails the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([respond({ kind: "result", payload: {} })]),
    );
    await run.settle();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toContain("holds no CALL");
  });

  test("a second callResponse for the same CALL fails the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("Reset"),
        respond({ kind: "result", payload: { status: "Accepted" } }, "a"),
        respond({ kind: "result", payload: { status: "Accepted" } }, "b"),
      ]),
    );
    await run.settle();
    run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toContain("already answered");
  });
});

describe("one open exchange per rule, branch-scoped ownership", () => {
  test("a second matching CALL gets onBusy while the first is open, the default error otherwise", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        replaceTrigger("UpdateFirmware", {
          onBusy: {
            kind: "error",
            errorCode: "InternalError",
            errorDescription: "busy",
          },
        }),
        delay(5),
        respond({ kind: "result", payload: {} }),
      ]),
    );
    await run.settle();
    const first = run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    const second = run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    expect(answerTo(run, second)).toMatchObject({
      kind: "error",
      payload: { code: "InternalError", description: "busy" },
    });
    // It never reached the default path: no train.
    await run.advance(6000);
    expect(answerTo(run, first)).toEqual({ kind: "result", payload: {} });
    expect(statuses(run)).toEqual([]);

    const plain = await runBehavior({ version: "1.6" });
    startScenario(
      plain,
      definition([
        replaceTrigger("Reset"),
        delay(5),
        respond({ kind: "none" }),
      ]),
    );
    await plain.settle();
    plain.callNoWait("Reset", { type: "Soft" });
    await plain.settle();
    const b = plain.callNoWait("Reset", { type: "Soft" });
    await plain.settle();
    expect(answerTo(plain, b)).toMatchObject({
      kind: "error",
      payload: { code: "GenericError" },
    });
    await plain.dispose();
  });

  test("parallel branches from Start own different CALLs", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        [
          replaceTrigger("UpdateFirmware"),
          respond({ kind: "result", payload: {} }, "r-fw"),
        ],
        [
          replaceTrigger("Reset"),
          delay(2),
          respond(
            { kind: "result", payload: { status: "Rejected" } },
            "r-reset",
          ),
        ],
      ]),
    );
    await run.settle();
    const reset = run.callNoWait("Reset", { type: "Hard" });
    const fw = run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    // Each branch answers its own CALL, in its own time.
    expect(answerTo(run, fw)).toEqual({ kind: "result", payload: {} });
    expect(answerTo(run, reset)).toBeUndefined();
    await run.advance(2000);
    expect(answerTo(run, reset)).toEqual({
      kind: "result",
      payload: { status: "Rejected" },
    });
    expect(scenario.state()).toBe("completed");
  });

  test("the rule ends with its CALL: the next one is the station's again", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        replaceTrigger("Reset"),
        respond({ kind: "result", payload: { status: "Rejected" } }),
        delay(60),
      ]),
    );
    await run.settle();
    const a = run.callNoWait("Reset", { type: "Hard" });
    await run.settle();
    expect(answerTo(run, a)).toEqual({
      kind: "result",
      payload: { status: "Rejected" },
    });
    const b = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    expect(answerTo(run, b)).toEqual({
      kind: "result",
      payload: { status: "Accepted" },
    });
  });
});

describe("useBehavior", () => {
  test("selects a dormant behavior for the run and fails on an unknown id", async () => {
    run = await runBehavior({ version: "1.6" });
    run.cp.loadBehavior(
      {
        api: 1,
        id: "refuse-reset",
        onCall: {
          Reset: {
            mode: "replace",
            handle: () => ({ response: { status: "Rejected" } }),
          },
        },
      },
      { dormant: true },
    );
    // Dormant: not serving yet.
    const before = await run.call("Reset", { type: "Soft" });
    expect(before.payload).toEqual({ status: "Accepted" });

    const scenario = startScenario(
      run,
      definition([
        {
          id: "use",
          type: "useBehavior",
          data: { behaviorId: "refuse-reset" },
        },
        delay(30),
      ]),
    );
    await run.settle();
    const during = await run.call("Reset", { type: "Soft" });
    expect(during.payload).toEqual({ status: "Rejected" });
    await run.advance(30_000);
    expect(scenario.state()).toBe("completed");
    // The run ended: the behavior is dormant again.
    const after = await run.call("Reset", { type: "Soft" });
    expect(after.payload).toEqual({ status: "Accepted" });

    const unknown = startScenario(
      run,
      definition(
        [{ id: "use", type: "useBehavior", data: { behaviorId: "nope" } }],
        "s-unknown",
      ),
    );
    await run.settle();
    expect(unknown.state()).toBe("error");
    expect(unknown.error()).toContain('No behavior with id "nope"');
  });
});
