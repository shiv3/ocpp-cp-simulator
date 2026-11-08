// Acceptance tests for #566: a JSON scenario and a code behavior can each match
// an incoming CALL, replace it completely, and control the payloads, order and
// delays of what follows; the default does not run. Both on OCPP 1.6 and
// 2.0.1, and for a second action to show it is generic.
import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { WireVersion } from "../goldenWire/FakeCsms";
import { runBehavior, type BehaviorRun } from "./runBehavior";
import { answerTo, definition, startScenario, type Step } from "./runScenario";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

type Provider = "behavior" | "scenario";
const CASES: ReadonlyArray<readonly [WireVersion, Provider]> = [
  ["1.6", "behavior"],
  ["1.6", "scenario"],
  ["2.0.1", "behavior"],
  ["2.0.1", "scenario"],
];

const LOCATION = "http://fw.example/custom.bin";
const PAST = "2020-01-01T00:00:00.000Z";

const updateFirmware = (v: WireVersion, location = LOCATION) =>
  v === "1.6"
    ? { location, retrieveDate: PAST }
    : {
        requestId: 31,
        firmware: { location, retrieveDateTime: PAST },
      };
/** The payload condition that picks the call out. */
const matchLocation = (v: WireVersion) =>
  v === "1.6" ? { location: LOCATION } : { firmware: { location: LOCATION } };
/** What the owner answers: not what the default would. */
const ownResponse = (v: WireVersion) =>
  v === "1.6"
    ? {}
    : { status: "Accepted", statusInfo: { reasonCode: "Custom" } };
const report = (v: WireVersion, status: string) =>
  v === "1.6" ? { status } : { status, requestId: 31 };

const statuses = (r: BehaviorRun): unknown[] =>
  r
    .callsOf("FirmwareStatusNotification")
    .map((f) => (f.payload as { status: string }).status);

interface Owner {
  readonly behaviors: Behavior[];
  /** Started after the station booted. */
  start(run: BehaviorRun): { stop(): Promise<void>; state(): string };
}

/**
 * The owner of UpdateFirmware: Downloading at once, Installing 1.5 s later,
 * Installed 2.5 s after that. No `Downloaded`, which the default train sends.
 */
function updateFirmwareOwner(
  v: WireVersion,
  provider: Provider,
  options: { holdSeconds?: number; onBusy?: "custom" } = {},
): Owner {
  const hold = options.holdSeconds ?? 0;
  if (provider === "behavior") {
    return {
      behaviors: [
        {
          api: 1,
          id: "own-firmware",
          onCall: {
            UpdateFirmware: {
              mode: "replace",
              match: matchLocation(v),
              ...(options.onBusy
                ? {
                    onBusy: {
                      error: { code: "InternalError", description: "busy" },
                    },
                  }
                : {}),
              handle: async (_req, ctx) => {
                if (hold > 0) await ctx.sleep(hold * 1000);
                return {
                  response: ownResponse(v),
                  after: async () => {
                    ctx.notify.firmwareStatus("Downloading", requestId(v));
                    await ctx.sleep(1500);
                    ctx.notify.firmwareStatus("Installing", requestId(v));
                    await ctx.sleep(2500);
                    ctx.notify.firmwareStatus("Installed", requestId(v));
                  },
                };
              },
            },
          },
        },
      ],
      start: (run) => ({
        stop: () => Promise.resolve(void run),
        state: () => "n/a",
      }),
    };
  }
  const send = (status: string, id: string): Step => ({
    id,
    type: "ocppCall",
    data: { action: "FirmwareStatusNotification", payload: report(v, status) },
  });
  const steps: Step[] = [
    {
      id: "trigger",
      type: "csmsCallTrigger",
      data: {
        action: "UpdateFirmware",
        behavior: "replace",
        payload: matchLocation(v),
        ...(options.onBusy
          ? {
              onBusy: {
                kind: "error",
                errorCode: "InternalError",
                errorDescription: "busy",
              },
            }
          : {}),
      },
    },
    ...(hold > 0
      ? [{ id: "hold", type: "delay", data: { delaySeconds: hold } }]
      : []),
    {
      id: "respond",
      type: "callResponse",
      data: { kind: "result", payload: ownResponse(v) },
    },
    send("Downloading", "n1"),
    { id: "d1", type: "delay", data: { delaySeconds: 1.5 } },
    send("Installing", "n2"),
    { id: "d2", type: "delay", data: { delaySeconds: 2.5 } },
    send("Installed", "n3"),
  ];
  return {
    behaviors: [],
    start: (run) => startScenario(run, definition(steps)),
  };
}
const requestId = (v: WireVersion) =>
  v === "1.6" ? undefined : { requestId: 31 };

async function boot(
  v: WireVersion,
  owner: Owner,
  connectors = 1,
): Promise<{ run: BehaviorRun; owned: ReturnType<Owner["start"]> }> {
  const run = await runBehavior({
    version: v,
    behaviors: owner.behaviors,
    connectors,
  });
  runs.push(run);
  const owned = owner.start(run);
  await run.settle();
  return { run, owned };
}

for (const [version, provider] of CASES) {
  describe(`#566 UpdateFirmware owned by a ${provider} on ${version}`, () => {
    test("matches, replaces completely, and controls payloads, order and delays", async () => {
      const { run } = await boot(
        version,
        updateFirmwareOwner(version, provider),
      );
      const id = run.callNoWait("UpdateFirmware", updateFirmware(version));
      await run.settle();
      expect(answerTo(run, id)).toEqual({
        kind: "result",
        payload: ownResponse(version),
      });
      expect(
        run.callsOf("FirmwareStatusNotification").map((f) => f.payload),
      ).toEqual([report(version, "Downloading")]);
      await run.advance(1499);
      expect(statuses(run)).toEqual(["Downloading"]);
      await run.advance(1);
      expect(statuses(run)).toEqual(["Downloading", "Installing"]);
      await run.advance(2499);
      expect(statuses(run)).toEqual(["Downloading", "Installing"]);
      await run.advance(1);
      expect(statuses(run)).toEqual(["Downloading", "Installing", "Installed"]);
      // The default sequence never ran, neither now nor later.
      await run.advance(120_000);
      expect(statuses(run)).toEqual(["Downloading", "Installing", "Installed"]);
      if (version === "2.0.1") {
        // The default would have remembered the request id.
        expect(run.cp.lastFirmwareRequestId).toBeUndefined();
      }
    });

    test("a call that does not match is the station's own", async () => {
      const { run } = await boot(
        version,
        updateFirmwareOwner(version, provider),
      );
      const id = run.callNoWait(
        "UpdateFirmware",
        updateFirmware(version, "http://other.example/f.bin"),
      );
      await run.settle();
      if (version === "1.6") {
        expect(answerTo(run, id)).toEqual({ kind: "result", payload: {} });
        await run.advance(8000);
        expect(statuses(run)).toEqual([
          "Downloading",
          "Downloaded",
          "Installing",
          "Installed",
        ]);
      } else {
        expect(answerTo(run, id)).toEqual({
          kind: "result",
          payload: { status: "Accepted" },
        });
        await run.advance(20_000);
        expect(statuses(run)).toEqual([]);
        expect(run.cp.lastFirmwareRequestId).toBe(31);
      }
    });

    test("concurrent calls: the second gets onBusy at once and never the default", async () => {
      const { run } = await boot(
        version,
        updateFirmwareOwner(version, provider, {
          holdSeconds: 1,
          onBusy: "custom",
        }),
      );
      const first = run.callNoWait("UpdateFirmware", updateFirmware(version));
      await run.settle();
      const second = run.callNoWait("UpdateFirmware", updateFirmware(version));
      await run.settle();
      expect(answerTo(run, second)).toMatchObject({
        kind: "error",
        payload: { code: "InternalError", description: "busy" },
      });
      expect(answerTo(run, first)).toBeUndefined();
      await run.advance(1000);
      expect(answerTo(run, first)).toEqual({
        kind: "result",
        payload: ownResponse(version),
      });
      // One owner's sequence only, no default train from the busy call.
      await run.advanceInSteps(10_000);
      expect(statuses(run)).toEqual(["Downloading", "Installing", "Installed"]);
    });

    test("cancellation while the CALL is open answers InternalError", async () => {
      const { run, owned } = await boot(
        version,
        updateFirmwareOwner(version, provider, { holdSeconds: 60 }),
      );
      const id = run.callNoWait("UpdateFirmware", updateFirmware(version));
      await run.settle();
      expect(answerTo(run, id)).toBeUndefined();
      if (provider === "behavior") {
        run.cp.unloadBehavior("own-firmware");
      } else {
        await owned.stop();
      }
      await run.settle();
      expect(answerTo(run, id)).toMatchObject({
        kind: "error",
        payload: { code: "InternalError" },
      });
      await run.advance(120_000);
      expect(statuses(run)).toEqual([]);
    });

    test("cancellation after the answer stops the rest of the sequence", async () => {
      const { run, owned } = await boot(
        version,
        updateFirmwareOwner(version, provider),
      );
      run.callNoWait("UpdateFirmware", updateFirmware(version));
      await run.settle();
      expect(statuses(run)).toEqual(["Downloading"]);
      if (provider === "behavior") {
        run.cp.unloadBehavior("own-firmware");
      } else {
        await owned.stop();
      }
      await run.advance(60_000);
      expect(statuses(run)).toEqual(["Downloading"]);
    });

    test("disconnect cleanup: no answer, no later notifications, and the next call is served again", async () => {
      const { run } = await boot(
        version,
        updateFirmwareOwner(version, provider, { holdSeconds: 5 }),
      );
      const id = run.callNoWait("UpdateFirmware", updateFirmware(version));
      await run.settle();
      run.cp.disconnect();
      await run.settle();
      await run.advance(60_000);
      expect(answerTo(run, id)).toBeUndefined();
      expect(statuses(run)).toEqual([]);

      run.cp.connect();
      await run.csms.waitForConnection();
      await run.settle();
      const again = run.callNoWait("UpdateFirmware", updateFirmware(version));
      await run.settle();
      if (provider === "behavior") {
        // The rule is free again: the behavior owns the new call.
        await run.advance(5000);
        expect(answerTo(run, again)).toEqual({
          kind: "result",
          payload: ownResponse(version),
        });
      } else {
        // The run ended with the disconnect; the station answers by itself.
        expect(answerTo(run, again)).toEqual({
          kind: "result",
          payload: version === "1.6" ? {} : { status: "Accepted" },
        });
      }
    });
  });
}

// A second action shows nothing here is specific to firmware: UnlockConnector
// exists on both versions with a different request, and a default that answers
// `Unlocked`.
const unlock = (v: WireVersion, connector: number) =>
  v === "1.6"
    ? { connectorId: connector }
    : { evseId: connector, connectorId: connector };
const matchConnector = (v: WireVersion) =>
  v === "1.6" ? { connectorId: 1 } : { evseId: 1 };

for (const [version, provider] of CASES) {
  describe(`#566 a second action: UnlockConnector owned by a ${provider} on ${version}`, () => {
    const owner = (): Owner =>
      provider === "behavior"
        ? {
            behaviors: [
              {
                api: 1,
                id: "refuse-unlock",
                onCall: {
                  UnlockConnector: {
                    mode: "replace",
                    match: matchConnector(version),
                    handle: () => ({ response: { status: "UnlockFailed" } }),
                  },
                },
              },
            ],
            start: () => ({
              stop: () => Promise.resolve(),
              state: () => "n/a",
            }),
          }
        : {
            behaviors: [],
            start: (run) =>
              startScenario(
                run,
                definition([
                  {
                    id: "trigger",
                    type: "csmsCallTrigger",
                    data: {
                      action: "UnlockConnector",
                      behavior: "replace",
                      payload: matchConnector(version),
                    },
                  },
                  {
                    id: "respond",
                    type: "callResponse",
                    data: {
                      kind: "result",
                      payload: { status: "UnlockFailed" },
                    },
                  },
                ]),
              ),
          };

    test("replaces the answer for the matching connector only", async () => {
      const { run } = await boot(version, owner(), 2);
      const mine = run.callNoWait("UnlockConnector", unlock(version, 1));
      await run.settle();
      expect(answerTo(run, mine)).toEqual({
        kind: "result",
        payload: { status: "UnlockFailed" },
      });
      const other = run.callNoWait("UnlockConnector", unlock(version, 2));
      await run.settle();
      expect(answerTo(run, other)).toEqual({
        kind: "result",
        payload: { status: "Unlocked" },
      });
    });
  });
}
