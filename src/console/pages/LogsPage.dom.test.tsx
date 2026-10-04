// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
  type FakeChargePointService,
  type ReportedLocation,
} from "../test/harness";
import { LogLevel, LogType } from "../../cp/shared/Logger";
import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
} from "../../data/interfaces/ChargePointService";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function snapshot(id: string): ChargePointSnapshot {
  return {
    id,
    status: "Available" as ChargePointSnapshot["status"],
    error: "",
    connectors: [],
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

const logEvent = (
  message: string,
  overrides: Partial<{ level: LogLevel; type: LogType; at: string }> = {},
): ChargePointEvent => ({
  type: "log",
  entry: {
    timestamp: new Date(overrides.at ?? "2026-01-01T10:00:00.000Z"),
    level: overrides.level ?? LogLevel.INFO,
    type: overrides.type ?? LogType.OCPP,
    message,
  },
});

describe("LogsPage", () => {
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

  async function mount(
    path: string,
    overrides: Partial<ChargePointService> = {},
  ) {
    const cpA = snapshot("CP-A");
    const cpB = snapshot("CP-B");
    const service = createFakeChargePointService({
      snapshots: [cpA, cpB],
      ...overrides,
    });
    const locations: ReportedLocation[] = [];
    const { container, root } = await renderConsole(path, {
      service,
      onLocationChange: (next) => locations.push(next),
    });
    cleanup = () => unmount(root);
    await flush();
    await pushRegistrySnapshot(service, [cpA, cpB]);
    await flush();
    return { container, service, locations };
  }

  const button = (container: HTMLElement, label: string) => {
    const found = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label,
    );
    if (!found) throw new Error(`expected a "${label}" button`);
    return found as HTMLButtonElement;
  };
  const click = async (el: Element) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const cpCheckbox = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(
      `[data-filter-group="Charge point"] label[data-filter-option="${id}"] input`,
    );
  const bodyRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("tbody tr"));
  const toolbar = (container: HTMLElement) =>
    container.querySelector('[data-testid="log-toolbar"]')?.textContent;

  it("fills the page with the log viewer: sidebar, toolbar, search and the log columns", async () => {
    const { container } = await mount("/logs");

    expect(container.querySelector("h1")?.textContent).toBe("Message Log");
    // The old two-pane list and detail pane are gone.
    expect(
      container.querySelector('select[aria-label="Filter by charge point"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain(
      "Select a message to see details.",
    );

    for (const group of ["Level", "Type", "Connector", "Direction", "Action"]) {
      expect(
        container.querySelector(`[data-filter-group="${group}"]`),
      ).toBeTruthy();
    }
    expect(toolbar(container)).toContain("0 total / 0 filtered");
    expect(container.querySelector("tbody")?.textContent).toContain(
      "No logs yet",
    );
    for (const label of ["Download", "Clear screen", "Clear screen + DB"]) {
      expect(button(container, label)).toBeTruthy();
    }
    expect(
      container.querySelector('input[placeholder="Search in messages..."]'),
    ).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll("thead th")).map((th) =>
        th.textContent?.trim(),
      ),
    ).toEqual([
      "Details",
      "Timestamp",
      "Level",
      "Type",
      "Direction",
      "Action",
      "Message",
    ]);
    // The Charge point group and column appear with the first line.
    expect(
      container.querySelector('[data-filter-group="Charge point"]'),
    ).toBeNull();
  });

  it("lists incoming rows of every charge point, oldest first, with a Charge point group and column", async () => {
    const { container, service } = await mount("/logs");

    await pushEvent(service, "CP-A", logEvent("BootNotification accepted"));
    await pushEvent(
      service,
      "CP-B",
      logEvent('Connection dropped {"code":1006}', {
        level: LogLevel.ERROR,
        type: LogType.WEBSOCKET,
        at: "2026-01-01T10:00:01.000Z",
      }),
    );

    expect(toolbar(container)).toContain("2 total / 2 filtered");
    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("CP-A");
    expect(rows[0].textContent).toContain("BootNotification accepted");
    expect(rows[1].textContent).toContain("CP-B");
    expect(rows[1].textContent).toContain("ERROR");
    expect(container.querySelector("thead")?.textContent).toContain(
      "Charge point",
    );

    expect(
      container.querySelector(
        '[data-filter-group="Charge point"] label[data-filter-option="CP-A"]',
      )?.textContent,
    ).toContain("1");
    expect(cpCheckbox(container, "CP-B")).toBeTruthy();
  });

  it("a chevron expands a row to its pretty-printed message", async () => {
    const { container, service } = await mount("/logs");
    await pushEvent(
      service,
      "CP-B",
      logEvent('Connection dropped {"code":1006}', { type: LogType.WEBSOCKET }),
    );
    expect(container.querySelector("pre")).toBeNull();

    await click(container.querySelector('button[aria-label="Show details"]')!);

    expect(container.querySelector("pre")?.textContent).toContain(
      '"code": 1006',
    );
  });

  describe("?cp= (charge point group in the URL)", () => {
    async function mountWithLogs(path: string) {
      const mounted = await mount(path);
      for (const [cpId, message] of [
        ["CP-A", "message of A"],
        ["CP-B", "message of B"],
      ] as const) {
        await pushEvent(mounted.service, cpId, logEvent(message));
      }
      return mounted;
    }

    it("/logs?cp=CP-A preselects CP-A and lists only its messages", async () => {
      const { container } = await mountWithLogs("/logs?cp=CP-A");

      expect(cpCheckbox(container, "CP-A")!.checked).toBe(true);
      expect(cpCheckbox(container, "CP-B")!.checked).toBe(false);
      expect(toolbar(container)).toContain("2 total / 1 filtered");
      expect(container.textContent).toContain("message of A");
      expect(container.textContent).not.toContain("message of B");
    });

    it("writes the group back to the URL (replace); unchecking the last one removes the param", async () => {
      const { container, locations } = await mountWithLogs("/logs");
      expect(toolbar(container)).toContain("2 total / 2 filtered");

      await click(cpCheckbox(container, "CP-B")!);
      expect(locations.at(-1)?.search).toBe("?cp=CP-B");
      expect(locations.at(-1)?.type).toBe("REPLACE");
      expect(toolbar(container)).toContain("2 total / 1 filtered");

      await click(cpCheckbox(container, "CP-A")!);
      expect(locations.at(-1)?.search).toBe("?cp=CP-B&cp=CP-A");
      expect(toolbar(container)).toContain("2 total / 2 filtered");

      await click(cpCheckbox(container, "CP-B")!);
      await click(cpCheckbox(container, "CP-A")!);
      expect(locations.at(-1)?.search).toBe("");
    });

    it("keeps the page's other params when it writes ?cp=", async () => {
      const { container, locations } = await mountWithLogs("/logs?x=1");
      await click(cpCheckbox(container, "CP-A")!);
      expect(locations.at(-1)?.search).toBe("?x=1&cp=CP-A");
    });

    it("an id from the URL that no charge point has stays listed and checked", async () => {
      const { container } = await mountWithLogs("/logs?cp=CP-gone");

      expect(cpCheckbox(container, "CP-gone")!.checked).toBe(true);
    });
  });

  it("Pause (in the page header) stops new events from appearing; Resume keeps them", async () => {
    const { container, service } = await mount("/logs");

    await click(button(container, "Pause"));
    await pushEvent(service, "CP-A", logEvent("dropped while paused"));
    expect(container.textContent).not.toContain("dropped while paused");
    expect(toolbar(container)).toContain("0 total");

    await click(button(container, "Resume"));
    await pushEvent(service, "CP-A", logEvent("kept after resume"));
    expect(container.textContent).toContain("kept after resume");

    // The page header, not the viewer's toolbar, owns Pause / Resume.
    expect(
      container.querySelector('[data-testid="log-toolbar"]')?.textContent,
    ).not.toContain("Pause");
  });

  it("Clear screen empties the selected charge points' lines only, and never touches the DB", async () => {
    const clearStoredLogs = vi.fn(async (_cpId: string) => {});
    const { container, service } = await mount("/logs?cp=CP-A", {
      clearStoredLogs,
    });
    await pushEvent(service, "CP-A", logEvent("message of A"));
    await pushEvent(service, "CP-B", logEvent("message of B"));
    expect(toolbar(container)).toContain("2 total / 1 filtered");

    await click(button(container, "Clear screen"));

    // CP-A's line is gone; CP-B's stays in the buffer behind the filter.
    expect(toolbar(container)).toContain("1 total / 0 filtered");
    expect(clearStoredLogs).not.toHaveBeenCalled();

    await click(cpCheckbox(container, "CP-A")!);
    await click(cpCheckbox(container, "CP-B")!);
    expect(container.textContent).toContain("message of B");
  });

  it("Clear screen with nothing selected empties every line", async () => {
    const { container, service } = await mount("/logs");
    await pushEvent(service, "CP-A", logEvent("message of A"));
    await pushEvent(service, "CP-B", logEvent("message of B"));

    await click(button(container, "Clear screen"));

    expect(toolbar(container)).toContain("0 total / 0 filtered");
  });

  it("Clear screen + DB also deletes the persisted rows of the selected charge points", async () => {
    const clearStoredLogs = vi.fn(async (_cpId: string) => {});
    const { container, service } = await mount("/logs?cp=CP-A&cp=CP-B", {
      clearStoredLogs,
    });
    await pushEvent(service, "CP-A", logEvent("message of A"));

    await click(button(container, "Clear screen + DB"));

    expect(clearStoredLogs).toHaveBeenCalledTimes(2);
    expect(clearStoredLogs).toHaveBeenCalledWith("CP-A");
    expect(clearStoredLogs).toHaveBeenCalledWith("CP-B");
    expect(toolbar(container)).toContain("0 total");
  });

  it("Clear screen + DB with nothing selected clears every charge point's rows", async () => {
    const clearStoredLogs = vi.fn(async (_cpId: string) => {});
    const { container } = await mount("/logs", { clearStoredLogs });

    await click(button(container, "Clear screen + DB"));

    expect(clearStoredLogs.mock.calls.map((c) => c[0]).sort()).toEqual([
      "CP-A",
      "CP-B",
    ]);
  });

  it("says why the persisted rows could not be cleared", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await mount("/logs?cp=CP-A", {
      clearStoredLogs: vi.fn(async () => {
        throw new Error("database closed");
      }),
    });

    await click(button(container, "Clear screen + DB"));
    await flush();

    expect(alert).toHaveBeenCalledWith(
      "Failed to clear stored logs: database closed",
    );
    vi.restoreAllMocks();
  });
});
