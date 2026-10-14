// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../test/harness";
import {
  defaultAutoMeterValueConfig,
  type AutoMeterValueConfig,
} from "../../../cp/domain/connector/MeterValueCurve";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";

interface CurveModalProps {
  isOpen: boolean;
  initialConfig: AutoMeterValueConfig;
  onSave: (config: AutoMeterValueConfig) => void;
  onClose: () => void;
}

// The real editor is a chart; the seam is its props.
const modal = vi.hoisted(() => ({ props: null as CurveModalProps | null }));
vi.mock("../../../components/MeterValueCurveModal", () => ({
  default: (props: CurveModalProps) => {
    modal.props = props;
    return <div data-testid="curve-modal" />;
  },
}));

function resetModal(): void {
  modal.props = null;
}

const LIVE: AutoMeterValueConfig = {
  enabled: true,
  intervalSeconds: 15,
  autoCalculateInterval: false,
  curvePoints: [
    { time: 0, value: 0 },
    { time: 600, value: 22 },
  ],
};

function snapshotWith(
  autoMeterValueConfig: AutoMeterValueConfig | null,
): ChargePointSnapshot {
  return {
    id: "CP-1",
    status: OCPPStatus.Available,
    error: "",
    connectors: [
      {
        id: 1,
        status: OCPPStatus.Available,
        availability: "Operative",
        meterValue: 0,
        transactionId: null,
        soc: null,
        mode: "manual",
        autoResetToAvailable: false,
        autoMeterValueConfig,
        evSettings: null,
        chargingProfile: null,
        chargingProfiles: [],
        transactionStartTime: null,
        transactionTagId: null,
        transactionBatteryCapacityKwh: null,
      },
    ],
  };
}

async function openEditor(
  live: AutoMeterValueConfig | null,
  overrides: Partial<ChargePointService> = {},
) {
  const service = createFakeChargePointService({
    snapshots: [snapshotWith(live)],
    getStateHistory: vi.fn(async () => []),
    getNetworkSimGlobal: vi.fn(async () => null),
    getNetworkSimCp: vi.fn(async () => ({
      config: null,
      resolved: {} as never,
    })),
    listScenarios: vi.fn(async () => []),
    ...overrides,
  });
  const { root } = await renderConsole("/cp/CP-1", { service });
  await flush();
  const trigger = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Auto meter values",
  );
  if (!trigger) throw new Error("no Auto meter values button");
  await act(async () => {
    trigger.click();
  });
  // The editor is lazy-loaded.
  for (let i = 0; i < 20 && !modal.props; i += 1) await flush();
  return { root };
}

describe("ConnectorCard: per-connector auto meter values (#418)", () => {
  let unmount: (() => void) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    resetModal();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("opens the curve editor on the connector's live configuration", async () => {
    const getAutoMeterConfig = vi.fn(async () => null);
    const { root } = await openEditor(LIVE, { getAutoMeterConfig });
    unmount = () => act(() => root.unmount());

    expect(modal.props?.isOpen).toBe(true);
    expect(modal.props?.initialConfig).toEqual(LIVE);
  });

  it("falls back to the saved configuration, then to the default", async () => {
    const saved = { ...LIVE, intervalSeconds: 60 };
    let { root } = await openEditor(null, {
      getAutoMeterConfig: vi.fn(async () => saved),
    });
    expect(modal.props?.initialConfig).toEqual(saved);
    await act(async () => root.unmount());
    resetModal();
    document.body.innerHTML = "";

    ({ root } = await openEditor(null, {
      getAutoMeterConfig: vi.fn(async () => null),
    }));
    unmount = () => act(() => root.unmount());
    expect(modal.props?.initialConfig).toEqual(defaultAutoMeterValueConfig);
  });

  it("does not open the editor on the default when the saved configuration cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await openEditor(null, {
      getAutoMeterConfig: vi.fn(async () => {
        throw new Error("db closed");
      }),
    });
    unmount = () => act(() => root.unmount());

    expect(modal.props).toBeNull();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Saved auto meter values not read: db closed",
    );
  });

  it("applies a saved curve to the connector and stores it", async () => {
    const setAutoMeterValueConfig = vi.fn(async () => {});
    const saveAutoMeterConfig = vi.fn(async () => {});
    const { root } = await openEditor(LIVE, {
      setAutoMeterValueConfig,
      saveAutoMeterConfig,
    });
    unmount = () => act(() => root.unmount());

    const next = { ...LIVE, intervalSeconds: 5 };
    await act(async () => {
      modal.props?.onSave(next);
      modal.props?.onClose();
    });
    await flush();

    expect(setAutoMeterValueConfig).toHaveBeenCalledWith("CP-1", 1, next);
    expect(saveAutoMeterConfig).toHaveBeenCalledWith("CP-1", 1, next);
  });

  it("says why the curve could not be applied", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await openEditor(LIVE, {
      setAutoMeterValueConfig: vi.fn(async () => {
        throw new Error("unknown connector");
      }),
    });
    unmount = () => act(() => root.unmount());

    await act(async () => {
      modal.props?.onSave(LIVE);
      modal.props?.onClose();
    });
    await flush();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Auto meter values not applied: unknown connector",
    );
  });

  it("says when the curve was applied but could not be saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const setAutoMeterValueConfig = vi.fn(async () => {});
    const { root } = await openEditor(LIVE, {
      setAutoMeterValueConfig,
      saveAutoMeterConfig: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    unmount = () => act(() => root.unmount());

    await act(async () => {
      modal.props?.onSave(LIVE);
      modal.props?.onClose();
    });
    await flush();

    expect(setAutoMeterValueConfig).toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Auto meter values applied, but not saved: disk full",
    );
  });
});
