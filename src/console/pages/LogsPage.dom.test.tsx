// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
  type FakeChargePointService,
} from "../test/harness";
import { LogLevel, LogType } from "../../cp/shared/Logger";
import type {
  ChargePointEvent,
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

  it("shows the waiting empty state, then lists + selects incoming log rows across CPs", async () => {
    const cpA = snapshot("CP-A");
    const cpB = snapshot("CP-B");
    const service = createFakeChargePointService({ snapshots: [cpA, cpB] });

    const { container, root } = await renderConsole("/logs", { service });
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Message Log");
    expect(container.textContent).toContain("Waiting for messages…");

    await pushRegistrySnapshot(service, [cpA, cpB]);
    await flush();

    await pushEvent(service, "CP-A", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:00.000Z"),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "BootNotification accepted",
      },
    });
    await pushEvent(service, "CP-B", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:01.000Z"),
        level: LogLevel.ERROR,
        type: LogType.WEBSOCKET,
        message: 'Connection dropped {"code":1006}',
      },
    });

    expect(container.textContent).not.toContain("Waiting for messages…");
    expect(container.textContent).toContain("CP-A");
    expect(container.textContent).toContain("CP-B");
    expect(container.textContent).toContain("BootNotification accepted");
    expect(container.textContent).toContain("2 shown · 2 total");

    // Newest (CP-B) is selected by default (first row) — detail pane shows
    // its full message with the JSON substring pretty-printed.
    expect(container.textContent).toContain('"code": 1006');

    // Select CP-A's row instead.
    const rowA = Array.from(container.querySelectorAll("tr[data-seq]")).find(
      (row) => row.textContent?.includes("BootNotification accepted"),
    );
    expect(rowA, "expected a row for the CP-A log entry").toBeTruthy();
    await act(async () => {
      (rowA as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container.textContent).toContain("BootNotification accepted");

    // CP filter narrows to CP-B only.
    const cpSelect = container.querySelector(
      'select[aria-label="Filter by charge point"]',
    ) as HTMLSelectElement;
    expect(cpSelect).toBeTruthy();
    await act(async () => {
      cpSelect.value = "CP-B";
      cpSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("1 shown · 2 total");
    expect(container.textContent).not.toContain("BootNotification accepted");
  });

  it("Pause stops new events from appearing; Clear empties the list", async () => {
    const cpA = snapshot("CP-A");
    const service = createFakeChargePointService({ snapshots: [cpA] });

    const { container, root } = await renderConsole("/logs", { service });
    cleanup = () => unmount(root);
    await flush();
    await pushRegistrySnapshot(service, [cpA]);
    await flush();

    const findButton = (label: string): HTMLButtonElement => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
      ) as HTMLButtonElement | undefined;
      if (!button) throw new Error(`expected a "${label}" button`);
      return button;
    };

    await act(async () => {
      findButton("Pause").click();
    });

    await pushEvent(service, "CP-A", {
      type: "log",
      entry: {
        timestamp: new Date(),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "dropped while paused",
      },
    });
    expect(container.textContent).toContain("Waiting for messages…");

    await act(async () => {
      findButton("Resume").click();
    });
    await pushEvent(service, "CP-A", {
      type: "log",
      entry: {
        timestamp: new Date(),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "kept after resume",
      },
    });
    expect(container.textContent).toContain("kept after resume");

    await act(async () => {
      findButton("Clear").click();
    });
    expect(container.textContent).toContain("Waiting for messages…");
    expect(container.textContent).not.toContain("kept after resume");
  });

  it("log rows are keyboard-operable: tabIndex=0, and Enter selects the row (updates the detail pane)", async () => {
    const cpA = snapshot("CP-A");
    const cpB = snapshot("CP-B");
    const service = createFakeChargePointService({ snapshots: [cpA, cpB] });

    const { container, root } = await renderConsole("/logs", { service });
    cleanup = () => unmount(root);
    await flush();
    await pushRegistrySnapshot(service, [cpA, cpB]);
    await flush();

    const timestampA = new Date("2026-01-01T10:00:00.000Z");
    await pushEvent(service, "CP-A", {
      type: "log",
      entry: {
        timestamp: timestampA,
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "first entry",
      },
    });
    await pushEvent(service, "CP-B", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:01.000Z"),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "second entry",
      },
    });

    // CP-B is newest, so it's selected by default; CP-A's row is not.
    const rowA = Array.from(container.querySelectorAll("tr[data-seq]")).find(
      (row) => row.textContent?.includes("first entry"),
    ) as HTMLElement | undefined;
    expect(rowA, "expected a row for the CP-A log entry").toBeTruthy();
    expect(rowA!.tabIndex).toBe(0);
    expect(rowA!.getAttribute("aria-selected")).toBe("false");
    expect(container.textContent).not.toContain(timestampA.toISOString());

    await act(async () => {
      rowA!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(rowA!.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain(timestampA.toISOString());
  });
});
