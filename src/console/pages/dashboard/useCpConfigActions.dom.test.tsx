// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useCpConfigActions } from "./useCpConfigActions";
import { createFakeChargePointService } from "../../test/harness";
import { DataContext } from "../../../data/providers/DataProvider";
import { useConfig } from "../../../data/hooks/useConfig";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointConfig } from "../../../components/ChargePointConfigModal";
import type {
  ChargePointService,
  ChargePointSnapshot,
  ConnectorSnapshot,
  CreateChargePointParams,
} from "../../../data/interfaces/ChargePointService";
import type {
  SimulatorConfigInput,
  WireSimulatorConfig,
} from "../../../protocol";

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const fixtureConfig: ChargePointConfig = {
  cpId: "CP-1",
  connectorNumber: 2,
  wsURL: "ws://localhost:9000/CP-1",
  ocppVersion: "OCPP-1.6J",
  basicAuthEnabled: true,
  basicAuthUsername: "user1",
  basicAuthPassword: "pass1",
  autoMeterValueEnabled: false,
  autoMeterValueInterval: 30,
  autoMeterValue: 10,
  chargePointVendor: "VendorX",
  chargePointModel: "ModelY",
  firmwareVersion: "1.0.0",
  chargeBoxSerialNumber: "CBSN-1",
  chargePointSerialNumber: "CPSN-1",
  meterSerialNumber: "MSN-1",
  meterType: "TypeA",
  iccid: "ICCID-1",
  imsi: "IMSI-1",
};

// Mirrors what `buildRemoteParams` (and, before it, TopPage.tsx's inline
// `params` object) should produce from `fixtureConfig`.
const expectedRemoteParams: CreateChargePointParams = {
  cpId: "CP-1",
  wsUrl: "ws://localhost:9000/CP-1",
  ocppVersion: "OCPP-1.6J",
  connectors: 2,
  vendor: "VendorX",
  model: "ModelY",
  basicAuth: { username: "user1", password: "pass1" },
  soapCallbackUrl: undefined,
  soapPath: undefined,
  securityProfile: undefined,
  authorizationKey: undefined,
  cpoName: undefined,
  tls: undefined,
  tlsCaPath: undefined,
  tlsCertPath: undefined,
  tlsKeyPath: undefined,
  bootNotification: {
    firmwareVersion: "1.0.0",
    chargeBoxSerialNumber: "CBSN-1",
    chargePointSerialNumber: "CPSN-1",
    meterSerialNumber: "MSN-1",
    meterType: "TypeA",
    iccid: "ICCID-1",
    imsi: "IMSI-1",
  },
  autoConnect: true,
};

function connectorSnapshot(
  overrides: Partial<ConnectorSnapshot> & { id: number },
): ConnectorSnapshot {
  return {
    status: OCPPStatus.Available,
    availability: "Operative",
    meterValue: 0,
    transactionId: null,
    soc: null,
    mode: "manual",
    autoResetToAvailable: false,
    autoMeterValueConfig: null,
    evSettings: null,
    chargingProfile: null,
    chargingProfiles: [],
    transactionStartTime: null,
    transactionTagId: null,
    transactionBatteryCapacityKwh: null,
    ...overrides,
  };
}

type ActionResult = { current: Promise<void> | null };

/** Exposes `useCpConfigActions()`'s three actions via buttons, plus
 *  `useConfig().isLoading` (as a data attribute) so tests can wait for the
 *  initial config load to settle before driving local-mode assertions. */
function Probe({
  cpConfig,
  resultRef,
}: {
  cpConfig: ChargePointConfig;
  resultRef: ActionResult;
}) {
  const { addCp, updateCp, removeCp } = useCpConfigActions();
  const { isLoading } = useConfig();
  return (
    <div data-testid="probe" data-loading={String(isLoading)}>
      <button
        data-testid="add"
        onClick={() => {
          resultRef.current = addCp(cpConfig);
        }}
      >
        add
      </button>
      <button
        data-testid="update"
        onClick={() => {
          resultRef.current = updateCp(cpConfig);
        }}
      >
        update
      </button>
      <button
        data-testid="remove"
        onClick={() => {
          resultRef.current = removeCp(cpConfig.cpId);
        }}
      >
        remove
      </button>
    </div>
  );
}

interface MountResult {
  root: Root;
  click: (testId: "add" | "update" | "remove") => Promise<void>;
}

/** Replicates harness.tsx's `renderConsole` DataContext wiring for a bare
 *  probe component (no MemoryRouter/DarkModeProvider needed — the hook only
 *  reads DataContext). */
async function mountProbe(
  service: ChargePointService,
  mode: "local" | "remote",
  cpConfig: ChargePointConfig = fixtureConfig,
): Promise<MountResult> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const resultRef: ActionResult = { current: null };

  await act(async () => {
    root.render(
      <DataContext.Provider
        value={{
          mode,
          serverUrl: "http://test",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service,
        }}
      >
        <Probe cpConfig={cpConfig} resultRef={resultRef} />
      </DataContext.Provider>,
    );
  });

  // useConfig()'s mount effect resolves loadConfig() over a couple of
  // microtask ticks — wait for isLoading to flip before driving any action
  // that reads `config` (local-mode remove needs the loaded value present).
  for (let i = 0; i < 10; i++) {
    const loading = container
      .querySelector('[data-testid="probe"]')
      ?.getAttribute("data-loading");
    if (loading === "false") break;
    await act(async () => {
      await Promise.resolve();
    });
  }

  const click = async (testId: "add" | "update" | "remove") => {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) throw new Error(`missing ${testId} button`);
    await act(async () => {
      button.click();
      await resultRef.current;
    });
  };

  return { root, click };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

describe("useCpConfigActions", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
    vi.restoreAllMocks();
  });

  describe("remote mode", () => {
    it("addCp calls createChargePoint with mapped params", async () => {
      const service = createFakeChargePointService();
      const { root, click } = await mountProbe(service, "remote");
      cleanup = () => unmount(root);

      await click("add");

      expect(service.createChargePoint).toHaveBeenCalledTimes(1);
      expect(service.createChargePoint).toHaveBeenCalledWith(
        expectedRemoteParams,
      );
      expect(service.updateChargePoint).not.toHaveBeenCalled();
    });

    it("updateCp calls updateChargePoint, not createChargePoint", async () => {
      const service = createFakeChargePointService();
      const { root, click } = await mountProbe(service, "remote");
      cleanup = () => unmount(root);

      await click("update");

      expect(service.updateChargePoint).toHaveBeenCalledTimes(1);
      expect(service.updateChargePoint).toHaveBeenCalledWith(
        expectedRemoteParams,
      );
      expect(service.createChargePoint).not.toHaveBeenCalled();
    });

    it("removeCp calls removeChargePoint with the cpId", async () => {
      const service = createFakeChargePointService();
      const { root, click } = await mountProbe(service, "remote");
      cleanup = () => unmount(root);

      await click("remove");

      expect(service.removeChargePoint).toHaveBeenCalledTimes(1);
      expect(service.removeChargePoint).toHaveBeenCalledWith("CP-1");
    });

    it("addCp with autoMeterValueEnabled applies per-connector auto-meter defaults", async () => {
      const cfg: ChargePointConfig = {
        ...fixtureConfig,
        autoMeterValueEnabled: true,
        autoMeterValueInterval: 45,
        autoMeterValue: 99,
      };
      const snapshot: ChargePointSnapshot = {
        id: "CP-1",
        status: OCPPStatus.Available,
        error: "",
        connectors: [
          connectorSnapshot({
            id: 1,
            autoMeterValueConfig: {
              enabled: false,
              autoCalculateInterval: false,
              intervalSeconds: 5,
              curvePoints: [
                { time: 0, value: 0 },
                { time: 60, value: 5 },
              ],
            },
          }),
          connectorSnapshot({
            id: 2,
            autoMeterValueConfig: {
              enabled: false,
              autoCalculateInterval: false,
              intervalSeconds: 5,
              curvePoints: [],
            },
          }),
          connectorSnapshot({ id: 3, autoMeterValueConfig: null }),
        ],
      };
      const service = createFakeChargePointService({ snapshots: [snapshot] });
      const { root, click } = await mountProbe(service, "remote", cfg);
      cleanup = () => unmount(root);

      await click("add");

      expect(service.getChargePoint).toHaveBeenCalledWith("CP-1");
      // All three connectors are configured — connector 3 (null config) gets
      // a fresh default rather than being skipped.
      expect(service.setAutoMeterValueConfig).toHaveBeenCalledTimes(3);
      // Connector 1: existing curve — only the last point's value is
      // replaced with the form's `autoMeterValue`.
      expect(service.setAutoMeterValueConfig).toHaveBeenCalledWith("CP-1", 1, {
        enabled: true,
        autoCalculateInterval: false,
        intervalSeconds: 45,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 60, value: 99 },
        ],
      });
      // Connector 2: no existing curve points — falls back to the default
      // two-point ramp.
      expect(service.setAutoMeterValueConfig).toHaveBeenCalledWith("CP-1", 2, {
        enabled: true,
        autoCalculateInterval: false,
        intervalSeconds: 45,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 30, value: 99 },
        ],
      });
      // Connector 3: no config at all (the common case for a brand-new CP) —
      // a sensible default is created, enabled:true, instead of skipping.
      expect(service.setAutoMeterValueConfig).toHaveBeenCalledWith("CP-1", 3, {
        enabled: true,
        autoCalculateInterval: false,
        intervalSeconds: 45,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 30, value: 99 },
        ],
      });
    });

    it("addCp with autoMeterValueEnabled:false disables existing per-connector generators", async () => {
      const cfg: ChargePointConfig = {
        ...fixtureConfig,
        autoMeterValueEnabled: false,
      };
      const snapshot: ChargePointSnapshot = {
        id: "CP-1",
        status: OCPPStatus.Available,
        error: "",
        connectors: [
          connectorSnapshot({
            id: 1,
            autoMeterValueConfig: {
              enabled: true,
              autoCalculateInterval: false,
              intervalSeconds: 5,
              curvePoints: [
                { time: 0, value: 0 },
                { time: 60, value: 5 },
              ],
            },
          }),
          connectorSnapshot({
            id: 2,
            autoMeterValueConfig: {
              enabled: true,
              autoCalculateInterval: true,
              intervalSeconds: 10,
              curvePoints: [{ time: 0, value: 0 }],
            },
          }),
        ],
      };
      const service = createFakeChargePointService({ snapshots: [snapshot] });
      const { root, click } = await mountProbe(service, "remote", cfg);
      cleanup = () => unmount(root);

      await click("add");

      // Disabling must actually turn every connector's generator off — not
      // early-return and leave them running.
      expect(service.setAutoMeterValueConfig).toHaveBeenCalledTimes(2);
      expect(service.setAutoMeterValueConfig).toHaveBeenCalledWith("CP-1", 1, {
        enabled: false,
        autoCalculateInterval: false,
        intervalSeconds: 5,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 60, value: 5 },
        ],
      });
      expect(service.setAutoMeterValueConfig).toHaveBeenCalledWith("CP-1", 2, {
        enabled: false,
        autoCalculateInterval: true,
        intervalSeconds: 10,
        curvePoints: [{ time: 0, value: 0 }],
      });
    });

    it("updateCp throws an explicit error when updateChargePoint is unavailable", async () => {
      const service = createFakeChargePointService({
        updateChargePoint: undefined,
      });
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      const { root, click } = await mountProbe(service, "remote");
      cleanup = () => unmount(root);

      await click("update");

      // No silent fall-back to create — the specific method is required.
      expect(service.createChargePoint).not.toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toContain(
        "updateChargePoint not supported",
      );
    });
  });

  describe("local mode", () => {
    function createStatefulConfigService(initial: WireSimulatorConfig | null) {
      let stored: WireSimulatorConfig | null = initial;
      const saveConfig = vi.fn(async (next: SimulatorConfigInput | null) => {
        stored = next as unknown as WireSimulatorConfig | null;
      });
      const loadConfig = vi.fn(async () => stored);
      const service = createFakeChargePointService({ saveConfig, loadConfig });
      return { service, saveConfig };
    }

    it("addCp persists the new CP into Experimental.ChargePointIDs", async () => {
      const { service, saveConfig } = createStatefulConfigService(null);
      const { root, click } = await mountProbe(service, "local");
      cleanup = () => unmount(root);

      await click("add");

      expect(saveConfig).toHaveBeenCalledTimes(1);
      const saved = saveConfig.mock.calls[0][0];
      expect(saved?.Experimental?.ChargePointIDs).toEqual([
        { ChargePointID: "CP-1", ConnectorNumber: 2 },
      ]);
      expect(saved?.wsURL).toBe("ws://localhost:9000/CP-1");
    });

    it("removeCp drops the CP from Experimental.ChargePointIDs", async () => {
      const initial: WireSimulatorConfig = {
        wsURL: "ws://localhost:9000/CP-OLD",
        ChargePointID: "CP-OLD",
        connectorNumber: 1,
        tagID: "123456",
        ocppVersion: "OCPP-1.6J",
        basicAuthSettings: { enabled: false, username: "" },
        autoMeterValueSetting: { enabled: false, interval: 0, value: 0 },
        Experimental: {
          ChargePointIDs: [
            { ChargePointID: "CP-OLD", ConnectorNumber: 1 },
            { ChargePointID: "CP-1", ConnectorNumber: 2 },
          ],
          TagIDs: ["123456"],
        },
        BootNotification: null,
      };
      const { service, saveConfig } = createStatefulConfigService(initial);
      const { root, click } = await mountProbe(service, "local");
      cleanup = () => unmount(root);

      // fixtureConfig.cpId ("CP-1") is what the probe's remove button
      // targets — the other seeded CP ("CP-OLD") must survive.
      await click("remove");

      expect(saveConfig).toHaveBeenCalledTimes(1);
      const saved = saveConfig.mock.calls[0][0];
      expect(saved?.Experimental?.ChargePointIDs).toEqual([
        { ChargePointID: "CP-OLD", ConnectorNumber: 1 },
      ]);
    });

    it("addCp rejects a duplicate local charge-point ID", async () => {
      const initial: WireSimulatorConfig = {
        wsURL: "ws://localhost:9000/CP-1",
        ChargePointID: "CP-1",
        connectorNumber: 2,
        tagID: "123456",
        ocppVersion: "OCPP-1.6J",
        basicAuthSettings: { enabled: false, username: "" },
        autoMeterValueSetting: { enabled: false, interval: 0, value: 0 },
        Experimental: {
          ChargePointIDs: [{ ChargePointID: "CP-1", ConnectorNumber: 2 }],
          TagIDs: ["123456"],
        },
        BootNotification: null,
      };
      const { service, saveConfig } = createStatefulConfigService(initial);
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      const { root, click } = await mountProbe(service, "local");
      cleanup = () => unmount(root);

      // fixtureConfig.cpId ("CP-1") already exists — adding it again must be
      // rejected, not persisted as a duplicate.
      await click("add");

      expect(saveConfig).not.toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toContain("already exists");
    });

    it("addCp surfaces a local persistence failure via alert (no unhandled rejection)", async () => {
      const saveConfig = vi.fn(async () => {
        throw new Error("disk full");
      });
      const loadConfig = vi.fn(async () => null);
      const service = createFakeChargePointService({ saveConfig, loadConfig });
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      const { root, click } = await mountProbe(service, "local");
      cleanup = () => unmount(root);

      // `click` awaits the returned promise — if the rejection escaped it
      // would surface here as an unhandled rejection / thrown error.
      await click("add");

      expect(saveConfig).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toContain("Failed to save CP");
    });
  });
});
