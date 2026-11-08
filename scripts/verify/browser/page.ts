// The page of the stage D2 browser check. Bundled for the browser by run.ts.
// It exposes window.__d2 to the Playwright driver and has the one thing the
// design asks for in the web build: a file input whose file is loaded as a
// behavior bundle through `import(blobUrl)` on LocalChargePointService.
import { LocalChargePointService } from "../../../apps/web/src/data/local/LocalChargePointService";
import {
  HOUR_MS,
  runFleet,
  sha256Lines,
} from "@ocpp-cp-sim/core/cp/shared/__tests__/virtualFleet";

interface RunOptions {
  wsUrl: string;
  cpId: string;
}

const service = new LocalChargePointService();
const status = document.getElementById("status") as HTMLElement;
const file = document.getElementById("bundle") as HTMLInputElement;
let options: RunOptions | null = null;
const loaded: string[] = [];
const errors: string[] = [];

async function setup(opts: RunOptions): Promise<void> {
  options = opts;
  await service.syncLocalChargePoints([
    {
      id: opts.cpId,
      connectorNumber: 1,
      bootNotification: {
        chargePointVendor: "ocpp-cp-simulator",
        chargePointModel: "browser-d2",
      },
      wsUrl: opts.wsUrl,
      basicAuth: null,
      autoMeterValueSetting: null,
      ocppVersion: "OCPP-1.6J",
    },
  ]);
}

file.addEventListener("change", async () => {
  const picked = file.files?.[0];
  if (!picked || !options) return;
  try {
    const ids = await service.loadBehaviorBundle(options.cpId, picked);
    loaded.push(...ids);
    status.textContent = `loaded ${ids.join(",")}`;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    status.textContent = `error ${errors[errors.length - 1]}`;
  }
});

const d2 = {
  setup,
  async connect(): Promise<void> {
    if (!options) throw new Error("setup first");
    await service.connect(options.cpId);
  },
  state: () => ({ loaded: [...loaded], errors: [...errors] }),
  async fleet(seed: string, chargers: number, hours: number) {
    const run = await runFleet(seed, chargers, hours);
    return {
      hash: await sha256Lines(run.all),
      effects: run.all.length,
      timers: run.timers,
      realMs: run.realMs,
      virtualHours: run.virtualMs / HOUR_MS,
    };
  },
  env: () => ({
    setImmediate: typeof (globalThis as { setImmediate?: unknown })
      .setImmediate,
    userAgent: navigator.userAgent,
  }),
};

(window as unknown as { __d2: typeof d2 }).__d2 = d2;
status.textContent = "ready";
