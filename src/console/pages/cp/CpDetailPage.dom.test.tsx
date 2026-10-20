// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
  type FakeChargePointService,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "../../../cp/shared/Logger";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import type { ChargePointEvent } from "../../../data/interfaces/ChargePointService";
import type { StateHistoryEntry } from "../../../cp/application/services/types/StateSnapshot";
import { useCpConfigActions } from "../dashboard/useCpConfigActions";

// `handleSaveConfig`'s catch is only reachable if `updateCp` itself rejects.
// The real `useCpConfigActions.updateCp` never does (both its local/remote
// branches swallow errors internally and always resolve — see its own
// "the returned promise always resolves" doc comment), so this module is
// mocked to force a rejection for that one test; every other test gets a
// harmless no-op default so `useCpConfigActions()`'s unconditional call in
// `CpDetailPage` keeps working normally.
vi.mock("../dashboard/useCpConfigActions", () => ({
  useCpConfigActions: vi.fn(() => ({
    addCp: vi.fn(async () => {}),
    updateCp: vi.fn(async () => {}),
    removeCp: vi.fn(async () => true),
  })),
}));

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

/** Flushes pending microtasks (e.g. `getChargePoint()`/`getStateHistory()`
 *  promise chains queued from a hook's mount effect) across a couple of
 *  ticks — one `await Promise.resolve()` doesn't always cover a promise
 *  chain with more than one `.then()` hop. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Picks a section of the lower half from its tab strip. */
async function openMoreSection(
  container: HTMLElement,
  label: string,
): Promise<void> {
  const item = Array.from(
    container.querySelectorAll<HTMLElement>(
      '[role="tablist"][aria-label="Charge point sections"] [role="tab"]',
    ),
  ).find((tab) => tab.textContent?.trim() === label);
  expect(item, `expected a "${label}" section tab`).toBeTruthy();
  await act(async () => {
    item!.click();
    await Promise.resolve();
  });
  await flush();
}

/** Opens the inline Config form from the header. */
async function openConfig(container: HTMLElement): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Config",
  );
  expect(button, "expected a Config button").toBeTruthy();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
  await flush();
}

/** Pushes a synthetic event to all handlers subscribed to a specific CP. */
async function pushEvent(
  service: FakeChargePointService,
  cpId: string,
  event: ChargePointEvent,
): Promise<void> {
  const handlers = service.__handlers.subscribe.get(cpId);
  if (!handlers || handlers.size === 0) {
    throw new Error(`no subscribe handler recorded for ${cpId}`);
  }
  await act(async () => {
    handlers.forEach((handler) => handler(event));
  });
}

function connector(
  overrides: Partial<ChargePointSnapshot["connectors"][number]> & {
    id: number;
  },
): ChargePointSnapshot["connectors"][number] {
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

function snapshot(
  overrides: Partial<ChargePointSnapshot> & { id: string },
): ChargePointSnapshot {
  return {
    status: OCPPStatus.Available,
    error: "",
    connectors: [],
    ...overrides,
  };
}

const txEntryFixture: StateHistoryEntry = {
  id: "hist-1",
  timestamp: new Date("2024-01-01T00:00:00.000Z"),
  entity: "connector",
  entityId: 1,
  transitionType: "transaction",
  fromState: "Available",
  toState: "Preparing",
  context: { source: "UI", timestamp: new Date("2024-01-01T00:00:00.000Z") },
  validationResult: { level: "OK" },
  success: true,
};

describe("CpDetailPage", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("shows the CP header, a disabled Start charging with no tags, and the fixture's transaction history in its tab", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [
        connector({ id: 1, status: OCPPStatus.Preparing }),
        connector({
          id: 2,
          status: OCPPStatus.Charging,
          transactionId: 7,
          transactionTagId: "TAG-7",
        }),
      ],
    });

    const getStateHistory = vi.fn(async () => [txEntryFixture]);
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory,
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    // Header: cpId shown (mono h1), status pill for the CP-level status.
    expect(container.textContent).toContain("CP-1");
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("CP-1");

    // Connector 1 card: plugged in, no global tag ids configured (fresh
    // jsdom localStorage) — the tag select is empty and Start charging is
    // disabled by the tag-flow, not by the button being unconditionally off.
    const connector1Card = container.querySelector('[data-connector-id="1"]');
    expect(connector1Card, "expected a card for connector 1").toBeTruthy();
    const startButton = connector1Card!.querySelector<HTMLButtonElement>(
      '[data-step="start"]',
    );
    expect(startButton?.dataset.state).toBe("next");
    expect(startButton!.disabled).toBe(true);

    // Connector 2's card, beside it on the full page: an active transaction,
    // so Stop charging is next, with the transaction and its tag.
    const connector2Card = container.querySelector('[data-connector-id="2"]');
    expect(connector2Card, "expected a card for connector 2").toBeTruthy();
    expect(connector2Card!.textContent).toContain("Tx #7 · TAG-7");
    const stopButton = connector2Card!.querySelector<HTMLButtonElement>(
      '[data-step="stop"][data-state="next"]',
    );
    expect(stopButton, "expected a Stop charging step").toBeTruthy();

    // Pick the Transactions tab and see the fixture row rendered
    // from useStateHistory's fetched history.
    await openMoreSection(container, "Transactions");

    expect(getStateHistory).toHaveBeenCalledWith("CP-1", {
      transitionType: "transaction",
    });
    expect(container.textContent).toContain("Available → Preparing");

    // A real service call: Stop charging on connector 2 wires
    // through to chargePointService.stopTransaction.
    await act(async () => {
      stopButton!.click();
      await Promise.resolve();
    });

    expect(service.stopTransaction).toHaveBeenCalledWith("CP-1", 2);
  });

  it("ConnectorCard: shows the Wh meter value in kWh and a rounded SoC, or — without a SoC", async () => {
    const cp = snapshot({
      id: "CP-1",
      connectors: [
        connector({
          id: 1,
          status: OCPPStatus.Charging,
          transactionId: 7,
          meterValue: 16208,
          soc: 20.462666666666667,
        }),
        connector({ id: 2, meterValue: 0, soc: null }),
      ],
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const connector1Card = container.querySelector('[data-connector-id="1"]');
    expect(connector1Card, "expected a card for connector 1").toBeTruthy();
    expect(connector1Card!.textContent).toContain("Meter16.21 kWh");
    expect(
      connector1Card!.querySelector('[data-testid="soc-hero"]')?.textContent,
    ).toBe("20.5%");

    const connector2Card = container.querySelector('[data-connector-id="2"]');
    expect(connector2Card, "expected a card for connector 2").toBeTruthy();
    expect(connector2Card!.textContent).toContain("Meter0.00 kWh");
    expect(
      connector2Card!.querySelector('[data-testid="soc-hero"]')?.textContent,
    ).toBe("—");
  });

  it("ConnectorCard: a rejecting stopTransaction is caught, isPending resets, and the failure is logged (not an unhandled rejection)", async () => {
    const cp = snapshot({
      id: "CP-1",
      connectors: [
        connector({
          id: 1,
          status: OCPPStatus.Charging,
          transactionId: 9,
        }),
      ],
    });
    const stopTransaction = vi.fn(async () => {
      throw new Error("stop boom");
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      stopTransaction,
      getStateHistory: vi.fn(async () => []),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const card = container.querySelector('[data-connector-id="1"]');
    expect(card, "expected a card for connector 1").toBeTruthy();
    const stopButton = card!.querySelector<HTMLButtonElement>(
      '[data-step="stop"][data-state="next"]',
    );
    expect(stopButton, "expected a Stop charging step").toBeTruthy();

    await act(async () => {
      stopButton!.click();
      await Promise.resolve();
    });
    await flush();

    expect(stopTransaction).toHaveBeenCalledWith("CP-1", 1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stop charging failed on CP-1/1"),
      expect.any(Error),
    );
    expect(card!.querySelector('[role="alert"]')?.textContent).toBe(
      "Stop charging failed: stop boom",
    );
    // isPending reset in `finally` — the button isn't stuck disabled after
    // the rejection settles.
    expect(stopButton!.disabled).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("ConnectorCard: Send status ignores a second click while the first call is still pending", async () => {
    const cp = snapshot({
      id: "CP-1",
      connectors: [connector({ id: 1 })],
    });
    let resolveStatus: (() => void) | null = null;
    const sendStatusNotification = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const service = createFakeChargePointService({
      snapshots: [cp],
      sendStatusNotification,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const card = container.querySelector('[data-connector-id="1"]');
    expect(card, "expected a card for connector 1").toBeTruthy();
    const status = card!.querySelector<HTMLSelectElement>(
      'select[aria-label="Status"]',
    )!;
    await act(async () => {
      status.value = OCPPStatus.Charging;
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const send = Array.from(card!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Send status",
    )!;

    await act(async () => {
      send.click();
      await Promise.resolve();
    });
    expect(sendStatusNotification).toHaveBeenCalledTimes(1);
    expect(sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Charging,
    );

    // While the first call is pending the group waits: a second click is
    // dropped.
    expect(send.disabled).toBe(true);
    await act(async () => {
      send.click();
      await Promise.resolve();
    });
    expect(sendStatusNotification).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStatus?.();
      await Promise.resolve();
    });
    await flush();

    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
      await Promise.resolve();
    });
    expect(sendStatusNotification).toHaveBeenCalledTimes(2);
  });

  it("CpDetailPage: a rejecting disconnect is caught, isConnectPending resets, and the failure is logged (not an unhandled rejection)", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });
    const disconnect = vi.fn(async () => {
      throw new Error("disconnect boom");
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      disconnect,
      getStateHistory: vi.fn(async () => []),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const disconnectButton = Array.from(
      container.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(disconnectButton, "expected a Disconnect button").toBeTruthy();

    await act(async () => {
      disconnectButton!.click();
      await Promise.resolve();
    });
    await flush();

    expect(disconnect).toHaveBeenCalledWith("CP-1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to disconnect CP-1"),
      expect.any(Error),
    );
    // isConnectPending reset in `finally` — the button isn't stuck disabled.
    expect(disconnectButton!.disabled).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("CpDetailPage: a rejecting updateCp is caught by handleSaveConfig and logged (not an unhandled rejection)", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory: vi.fn(async () => []),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const updateCp = vi.fn(async () => {
      throw new Error("save boom");
    });
    vi.mocked(useCpConfigActions).mockReturnValue({
      addCp: vi.fn(async () => {}),
      updateCp,
      removeCp: vi.fn(async () => true),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    await openConfig(container);

    const saveButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Save");
    expect(
      saveButton,
      "expected a Save button in the config form",
    ).toBeTruthy();

    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
    });
    await flush();

    expect(updateCp).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save config for CP-1"),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });

  it("the message log shows entries logged before navigating to the CP (from global ring buffer)", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory: vi.fn(async () => []),
    });

    // Render at dashboard (/) so CpDetailPage is NOT mounted yet, but
    // GlobalLogsProvider IS mounted (via AppShell). This is the key to
    // reproducing the bug: log events delivered now go into globalLogEntries
    // but will NOT be in useChargePointView's view.logs (which only exists
    // after CpDetailPage mounts).
    const { container, root } = await renderConsole("/", { service });
    cleanup = () => unmount(root);
    await flush();

    // Notify GlobalLogsProvider about the CP registry snapshot so it knows to
    // subscribe to CP-1.
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cp] });
      }
      await Promise.resolve();
    });
    await flush();

    // Emit a log entry for CP-1 BEFORE navigating to its detail page. This
    // log will be in the global ring buffer but NOT in useChargePointView
    // (which doesn't exist yet). This is what the bug reproduces: the old code
    // would show nothing in the tab because view.logs is empty.
    await pushEvent(service, "CP-1", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:00.000Z"),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        // Names connector 1, the selected one: the log tab filters to it.
        message: "BootNotification accepted on connector 1",
      },
    });
    await flush();

    // Navigate to CP-1's detail page: open its card in the side panel, then
    // expand the panel to the full page.
    const cpButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "CP-1",
    );
    expect(cpButton, "expected CP-1's card in the dashboard").toBeTruthy();

    await act(async () => {
      cpButton!.click();
      await Promise.resolve();
    });
    await flush();

    const expandLink = container.querySelector<HTMLElement>(
      '[aria-label="Open as full page"]',
    );
    expect(expandLink, "expected the panel's expand link").toBeTruthy();

    await act(async () => {
      expandLink!.click();
      await Promise.resolve();
    });
    await flush();

    // The message log is the lower half by default: the message emitted
    // BEFORE navigating to this CP should be visible.
    // The old code would fail here because useChargePointView's view.logs
    // never received the event (it wasn't mounted yet). The fix makes the log
    // read from the global ring buffer instead, so it shows all entries for
    // this CP, including those logged before the page mounted.
    expect(container.textContent).toContain("BootNotification accepted");
  });

  it("the message log Clear button hides old entries but shows new ones", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    // Notify GlobalLogsProvider about the CP registry snapshot.
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cp] });
      }
      await Promise.resolve();
    });
    await flush();

    // Emit an initial log entry.
    await pushEvent(service, "CP-1", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:00.000Z"),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "initial entry on connector 1",
      },
    });
    await flush();

    // Verify the initial entry is shown.
    expect(container.textContent).toContain("initial entry");

    // Click the "Clear screen" button to clear the tab's visible logs.
    const clearButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Clear screen",
    );
    expect(clearButton, "expected a Clear screen button").toBeTruthy();

    await act(async () => {
      clearButton!.click();
      await Promise.resolve();
    });
    await flush();

    // The old entry should now be gone.
    expect(container.textContent).not.toContain("initial entry");

    // Emit a new log entry after clearing.
    await pushEvent(service, "CP-1", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:01.000Z"),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "new entry after clear on connector 1",
      },
    });
    await flush();

    // The new entry should be visible.
    expect(container.textContent).toContain("new entry after clear");
  });
});

describe("CpDetailPage SOAP callback URL (#183)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  const soapCp = snapshot({
    id: "CP-1",
    connectors: [connector({ id: 1 })],
    config: {
      wsUrl: "http://csms.example.test/steve/services/CentralSystemService",
      ocppVersion: "OCPP-1.6S",
      connectors: 1,
      vendor: "V",
      model: "M",
      basicAuth: null,
      soapCallbackUrl:
        "https://a1b2.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
      soapCallbackUrlDerived: true,
      soapPath: "/ocpp/soap",
      bootNotification: null,
    },
  });

  it("the Config form shows the effective callback URL with a copy button, and says it comes from the tunnel", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const service = createFakeChargePointService({
      snapshots: [soapCp],
      getStateHistory: vi.fn(async () => []),
      getServerInfo: vi.fn(async () => ({
        version: "1.2.3",
        soap: {
          publicBaseUrl: "https://a1b2.ngrok-free.app",
          path: "/ocpp/soap",
          tunnel: { provider: "ngrok" as const, mode: "spawn" as const },
        },
      })),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openConfig(container);

    expect(container.textContent).toContain(
      "https://a1b2.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
    );
    expect(container.textContent).toContain("derived from the ngrok tunnel");

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Copy",
    );
    expect(copyButton, "expected a Copy button").toBeTruthy();
    await act(async () => {
      copyButton!.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      "https://a1b2.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
    );
  });

  it("says so when the clipboard refuses the copy instead of failing silently", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = createFakeChargePointService({
      snapshots: [soapCp],
      getStateHistory: vi.fn(async () => []),
      getServerInfo: vi.fn(async () => null),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openConfig(container);

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Copy",
    );
    expect(copyButton, "expected a Copy button").toBeTruthy();
    await act(async () => {
      copyButton!.click();
      await Promise.resolve();
    });
    await flush();
    expect(copyButton!.textContent?.trim()).toBe("Copy failed");
  });

  it("hands the daemon's public base to the edit form so the callback URL is previewed, not sent back", async () => {
    const service = createFakeChargePointService({
      snapshots: [soapCp],
      getStateHistory: vi.fn(async () => []),
      getServerInfo: vi.fn(async () => ({
        version: "1.2.3",
        soap: {
          publicBaseUrl: "https://a1b2.ngrok-free.app",
          path: "/ocpp/soap",
          tunnel: { provider: "ngrok" as const, mode: "spawn" as const },
        },
      })),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openConfig(container);

    const input = document.getElementById(
      "soapCallbackUrl",
    ) as HTMLInputElement | null;
    expect(input, "expected the SOAP callback URL field").toBeTruthy();
    expect(input!.value).toBe("");
    expect(input!.placeholder).toBe(
      "https://a1b2.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
    );
    expect(input!.required).toBe(false);
  });

  it("shows an explicit callback URL without the tunnel note", async () => {
    const service = createFakeChargePointService({
      snapshots: [
        snapshot({
          ...soapCp,
          config: {
            ...soapCp.config!,
            soapCallbackUrl:
              "https://explicit.test/ocpp/soap/CP-1/ChargePointService",
            soapCallbackUrlDerived: false,
          },
        }),
      ],
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openConfig(container);

    expect(container.textContent).toContain(
      "https://explicit.test/ocpp/soap/CP-1/ChargePointService",
    );
    expect(container.textContent).not.toContain("derived from");
  });

  it("Expert section offers the station calls of the CP's OCPP version (#389)", async () => {
    const cp = snapshot({
      id: "CP-1",
      connectors: [connector({ id: 1 })],
      config: { ocppVersion: "OCPP-2.0.1" } as ChargePointSnapshot["config"],
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory: vi.fn(async () => []),
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    await openMoreSection(container, "Expert");

    const actions = Array.from(
      container.querySelectorAll<HTMLOptionElement>(
        'select[aria-label="Action"] option',
      ),
    ).map((o) => o.value);
    expect(actions).toContain("TransactionEvent");
    expect(actions).not.toContain("StartTransaction");
  });
});
