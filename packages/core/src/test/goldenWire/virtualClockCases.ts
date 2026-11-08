// Golden cases that run on a VirtualClock with the station and the fake CSMS
// wired in memory: scheduled and cancelled firmware / log trains, whose timers
// would take real seconds. The clock starts at 2030-01-01 and moves only when
// a case advances it.
import { SIGNING_CERTIFICATE } from "../../cp/domain/security/__tests__/signingCertificateFixture";
import { drainMicrotasks, VirtualClock } from "../../cp/shared/clock";
import type { GoldenCase } from "./cases";
import type { Rig } from "./rig";

export const virtualClockCases: GoldenCase[] = [];

const PAST = "2020-01-01T00:00:00.000Z";

type VirtualRun = (
  rig: Rig,
  advance: (ms: number) => Promise<void>,
) => Promise<void>;

/** A 1.6 case on its own VirtualClock; `advance` moves it and settles. */
function v16(name: string, run: VirtualRun): void {
  const clock = new VirtualClock();
  virtualClockCases.push({
    name: `16-${name}`,
    version: "1.6",
    options: { memory: true, simulation: { clock, seed: "golden" } },
    run: (rig) =>
      run(rig, async (ms) => {
        await clock.advanceBy(ms);
        await rig.csms.settle();
        await drainMicrotasks();
      }),
  });
}

const signedFirmware = (
  requestId: number,
  extra: Record<string, unknown> = {},
) => ({
  requestId,
  firmware: {
    location: "https://fw.example.test/signed.bin",
    retrieveDateTime: PAST,
    signingCertificate: SIGNING_CERTIFICATE,
    signature: "c2lnbmF0dXJl",
    ...extra,
  },
});

// #740 L01.FR.26: a second SignedUpdateFirmware mid-train cancels the first
// (AcceptedCanceled); only the second request's train runs to Installed.
v16("signed-update-firmware-cancelled", async (rig, advance) => {
  await rig.csms.call("SignedUpdateFirmware", signedFirmware(11));
  await advance(2500);
  await rig.csms.call("SignedUpdateFirmware", signedFirmware(12));
  await advance(20_000);
});

// #740 N01.FR.11: a second GetLog mid-upload cancels the first
// (AcceptedCanceled); only the second requestId reaches Uploaded.
v16("get-log-cancelled", async (rig, advance) => {
  const request = (requestId: number) => ({
    logType: "DiagnosticsLog",
    requestId,
    log: { remoteLocation: "http://upload.example.test/log" },
  });
  await rig.csms.call("GetLog", request(21));
  await advance(500);
  await rig.csms.call("GetLog", request(22));
  await advance(5000);
});
