// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { useGlobalLogs } from "./useGlobalLogs";
import { GlobalLogsProvider } from "./GlobalLogsProvider";
import {
  createFakeChargePointService,
  renderConsole,
  type FakeChargePointService,
} from "../test/harness";
import { DataContext } from "../../data/providers/DataProvider";
import { LogLevel, LogType } from "../../cp/shared/Logger";
import type { ChargePointSnapshot } from "../../data/interfaces/ChargePointService";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

function snapshot(id: string): ChargePointSnapshot {
  return {
    id,
    status: "Available" as ChargePointSnapshot["status"],
    error: "",
    connectors: [],
  };
}

function logEvent(
  message: string,
  overrides?: Partial<{ level: LogLevel; type: LogType }>,
) {
  return {
    type: "log" as const,
    entry: {
      timestamp: new Date(),
      level: overrides?.level ?? LogLevel.INFO,
      type: overrides?.type ?? LogType.OCPP,
      message,
    },
  };
}

async function pushRegistrySnapshot(
  service: FakeChargePointService,
  cps: ChargePointSnapshot[],
): Promise<void> {
  await act(async () => {
    for (const handler of service.__handlers.subscribeRegistry) {
      handler({ type: "snapshot", cps });
    }
    await Promise.resolve();
  });
}

async function pushLog(
  service: FakeChargePointService,
  cpId: string,
  message: string,
  overrides?: Partial<{ level: LogLevel; type: LogType }>,
): Promise<void> {
  const handlers = service.__handlers.subscribe.get(cpId);
  if (!handlers || handlers.size === 0) {
    throw new Error(`no subscribe handler recorded for ${cpId}`);
  }
  await act(async () => {
    handlers.forEach((handler) => handler(logEvent(message, overrides)));
  });
}

let latestHookApi: ReturnType<typeof useGlobalLogs> | null = null;

function Probe() {
  const api = useGlobalLogs();
  latestHookApi = api;
  return (
    <div>
      <div data-testid="count">{api.entries.length}</div>
      <div data-testid="paused">{String(api.paused)}</div>
      <ul>
        {api.entries.map((e) => (
          <li key={e.seq}>
            {e.cpId}:{e.entry.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Renders `<Probe/>` inside a `<GlobalLogsProvider>` (the same provider
 *  `AppShell` mounts in the real app) wired to a `DataContext` — exercises
 *  the ring-buffer/pause/eviction behavior now owned by the provider, one
 *  level down from the full route tree so these tests stay focused on the
 *  buffer semantics rather than routing. */
async function renderProbe(
  service: FakeChargePointService,
  max?: number,
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DataContext.Provider
        value={{
          mode: "remote",
          serverUrl: "http://test",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service,
        }}
      >
        <GlobalLogsProvider max={max}>
          <Probe />
        </GlobalLogsProvider>
      </DataContext.Provider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

describe("useGlobalLogs", () => {
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
    latestHookApi = null;
  });

  it("throws when called outside a <GlobalLogsProvider>", () => {
    // Suppress the expected React error-boundary console.error noise for
    // this one assertion.
    const originalError = console.error;
    console.error = () => {};
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      expect(() => {
        act(() => {
          root.render(<Probe />);
        });
      }).toThrow(/GlobalLogsProvider/);
      root.unmount();
    } finally {
      console.error = originalError;
    }
  });

  it("aggregates log events from every CP, newest first, tagged with cpId", async () => {
    const service = createFakeChargePointService({
      snapshots: [snapshot("CP-1"), snapshot("CP-2")],
    });
    const { container, root } = await renderProbe(service);
    cleanup = () => unmount(root);
    await pushRegistrySnapshot(service, [snapshot("CP-1"), snapshot("CP-2")]);

    await pushLog(service, "CP-1", "first");
    await pushLog(service, "CP-2", "second");

    expect(latestHookApi?.entries).toHaveLength(2);
    expect(latestHookApi!.entries[0]).toMatchObject({
      cpId: "CP-2",
      entry: { message: "second" },
    });
    expect(latestHookApi!.entries[1]).toMatchObject({
      cpId: "CP-1",
      entry: { message: "first" },
    });
    expect(latestHookApi!.entries[0].seq).toBeGreaterThan(
      latestHookApi!.entries[1].seq,
    );
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe(
      "2",
    );
  });

  it("evicts the oldest entry once max is exceeded (ring buffer)", async () => {
    const service = createFakeChargePointService({
      snapshots: [snapshot("CP-1")],
    });
    const { root } = await renderProbe(service, 2);
    cleanup = () => unmount(root);
    await pushRegistrySnapshot(service, [snapshot("CP-1")]);

    await pushLog(service, "CP-1", "one");
    await pushLog(service, "CP-1", "two");
    await pushLog(service, "CP-1", "three");

    expect(latestHookApi?.entries).toHaveLength(2);
    expect(latestHookApi!.entries.map((e) => e.entry.message)).toEqual([
      "three",
      "two",
    ]);
  });

  it("drops events pushed while paused, and resumes appending once unpaused", async () => {
    const service = createFakeChargePointService({
      snapshots: [snapshot("CP-1")],
    });
    const { root } = await renderProbe(service);
    cleanup = () => unmount(root);
    await pushRegistrySnapshot(service, [snapshot("CP-1")]);

    await act(async () => {
      latestHookApi!.setPaused(true);
    });
    expect(latestHookApi?.paused).toBe(true);

    await pushLog(service, "CP-1", "dropped");
    expect(latestHookApi?.entries).toHaveLength(0);

    await act(async () => {
      latestHookApi!.setPaused(false);
    });
    await pushLog(service, "CP-1", "kept");

    expect(latestHookApi?.entries).toHaveLength(1);
    expect(latestHookApi!.entries[0].entry.message).toBe("kept");
  });

  it("clear() empties accumulated entries", async () => {
    const service = createFakeChargePointService({
      snapshots: [snapshot("CP-1")],
    });
    const { root } = await renderProbe(service);
    cleanup = () => unmount(root);
    await pushRegistrySnapshot(service, [snapshot("CP-1")]);

    await pushLog(service, "CP-1", "one");
    expect(latestHookApi?.entries).toHaveLength(1);

    await act(async () => {
      latestHookApi!.clear();
    });
    expect(latestHookApi?.entries).toHaveLength(0);
  });

  it("subscribes to every CP id returned by useChargePoints and unsubscribes on unmount", async () => {
    const service = createFakeChargePointService({
      snapshots: [snapshot("CP-1"), snapshot("CP-2")],
    });
    const { root } = await renderProbe(service);
    await pushRegistrySnapshot(service, [snapshot("CP-1"), snapshot("CP-2")]);

    expect(service.__handlers.subscribe.get("CP-1")?.size).toBe(1);
    expect(service.__handlers.subscribe.get("CP-2")?.size).toBe(1);

    await unmount(root);

    expect(service.__handlers.subscribe.get("CP-1")?.size).toBe(0);
    expect(service.__handlers.subscribe.get("CP-2")?.size).toBe(0);
  });

  it("keeps entries collected on the Dashboard after navigating to /logs (provider survives route change)", async () => {
    const cpA = snapshot("CP-A");
    const service = createFakeChargePointService({ snapshots: [cpA] });

    // Mounts through the real route tree (ConsoleRoutes -> AppShell ->
    // Outlet), which is what actually exercises the fix: GlobalLogsProvider
    // is mounted once in AppShell, a layout route that stays mounted across
    // `/` <-> `/logs`, instead of being recreated per-page.
    const { container, root } = await renderConsole("/", { service });
    cleanup = () => unmount(root);

    await pushRegistrySnapshot(service, [cpA]);
    await act(async () => {
      await Promise.resolve();
    });

    await pushLog(service, "CP-A", "collected on dashboard");

    // Sanity check: the entry actually landed while on the Dashboard.
    expect(container.textContent).toContain("collected on dashboard");

    const logsLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Message Log",
    );
    expect(logsLink, 'expected a "Message Log" nav link').toBeTruthy();

    await act(async () => {
      logsLink!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Before the fix, LogsPage mounted its own fresh useGlobalLogs() and
    // this entry — collected while on the Dashboard — would be gone.
    expect(container.textContent).toContain("Message Log");
    expect(container.textContent).toContain("collected on dashboard");
    expect(container.textContent).toContain("1 shown · 1 total");
  });
});
