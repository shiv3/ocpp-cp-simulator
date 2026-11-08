// 4e8a67d6 made runDefault's scope not connection-bound until its effect starts.
// An effect the response queue drops (station-initiated close, stale generation)
// never starts, so nothing ever ends that scope: it stays in callScopes for the
// station's life. Before 4e8a67d6 the next connection close ended it.
import { expect, test } from "bun:test";
import { Rig } from "../goldenWire/rig";
import { resolveNetworkSimConfig } from "../../cp/infrastructure/transport/network-sim";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAST = "2020-01-01T00:00:00.000Z";

test("a dropped default follow-up does not leave its scope behind", async () => {
  const rig = await Rig.create({ version: "1.6" });
  try {
    rig.cp.setNetworkSimConfig(
      resolveNetworkSimConfig(
        {
          enabled: true,
          seed: 1,
          rules: {
            l: { type: "latency", direction: "upstream", delayMs: 500 },
          },
        },
        null,
        "CP-GOLDEN",
      ),
    );
    const scopes = () =>
      (rig.cp.engine as unknown as { callScopes: Set<unknown> }).callScopes
        .size;
    for (let i = 0; i < 3; i++) {
      rig.csms.callNoWait("UpdateFirmware", {
        location: "http://x",
        retrieveDate: PAST,
      });
      await wait(100);
      rig.cp.disconnect(); // station-initiated close: the response queue drops the effect
      await wait(800);
      rig.cp.connect();
      await rig.csms.waitForCall("BootNotification", {
        nth: i + 2,
        timeoutMs: 10_000,
      });
      await rig.csms.settle();
      await wait(300);
    }
    rig.cp.disconnect();
    await wait(800);
    const fw = rig.csms.frames.filter(
      (f) =>
        f.dir === "CP>" &&
        f.kind === "call" &&
        f.action === "FirmwareStatusNotification",
    );
    console.log("firmware notifications", fw.length, "scopes", scopes());
    expect(scopes()).toBe(0);
  } finally {
    await rig.dispose();
  }
}, 60_000);
