// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
  type FakeChargePointService,
  type ReportedLocation,
} from "../test/harness";
import { LogLevel, LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type {
  ChargePointEvent,
  ChargePointSnapshot,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";

function snapshot(id: string): ChargePointSnapshot {
  return {
    id,
    status: "Available" as ChargePointSnapshot["status"],
    error: "",
    connectors: [],
  };
}

const logEvent = (
  message: string,
  type: LogType = LogType.WEBSOCKET,
): ChargePointEvent => ({
  type: "log",
  entry: {
    timestamp: new Date("2026-11-10T09:00:00.000Z"),
    level: LogLevel.INFO,
    type,
    message,
  },
});

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

/** Radix tabs activate on mouse down, not on click. */
async function selectTab(tab: Element): Promise<void> {
  await act(async () => {
    tab.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  });
  await flush();
}

const tab = (container: HTMLElement, label: string) => {
  const found = Array.from(container.querySelectorAll('[role="tab"]')).find(
    (el) => el.textContent?.trim() === label,
  );
  if (!found) throw new Error(`expected a "${label}" tab`);
  return found;
};

/** The options of a filter group of the trace viewer, as "label: checked". */
const filterOptions = (container: HTMLElement, legend: string) => {
  const group = Array.from(
    container.querySelectorAll(".oot-filter-group"),
  ).find(
    (el) => el.querySelector(".oot-filter-legend")?.textContent === legend,
  );
  if (!group) throw new Error(`expected a "${legend}" filter group`);
  return Array.from(group.querySelectorAll("label")).map(
    (label) =>
      `${label.textContent?.trim()}: ${label.querySelector("input")?.checked}`,
  );
};

describe("LogsPage trace view", () => {
  let root: Root | null = null;

  beforeAll(async () => {
    // The page lazy-loads the trace view: load it once up front.
    await import("../components/TraceView");
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    const mounted = root;
    root = null;
    if (mounted) {
      await act(async () => {
        mounted.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  async function mount(path: string) {
    const cps = [snapshot("CP-A"), snapshot("CP-B")];
    const service = createFakeChargePointService({ snapshots: cps });
    const locations: ReportedLocation[] = [];
    const rendered = await renderConsole(path, {
      service,
      onLocationChange: (next) => locations.push(next),
    });
    root = rendered.root;
    await flush();
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps });
      }
    });
    await flush();
    return { container: rendered.container, service, locations };
  }

  it("opens on the log view, and switches to the trace view keeping the charge point filter", async () => {
    const { container, locations } = await mount("/logs?cp=CP-A");

    expect(tab(container, "Log").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".oot-viewer-list")).toBeNull();

    await selectTab(tab(container, "Trace"));

    expect(tab(container, "Trace").getAttribute("aria-selected")).toBe("true");
    expect(locations.at(-1)?.search).toBe("?cp=CP-A&view=trace");
  });

  it("shows the wire frames of every charge point as trace entries, filtered by ?cp=", async () => {
    const { container, service } = await mount("/logs?view=trace&cp=CP-A");
    await flush(10);

    await pushEvent(
      service,
      "CP-A",
      logEvent('Sent: [2,"a-1","Heartbeat",{}]'),
    );
    await pushEvent(service, "CP-A", logEvent("Connected", LogType.OCPP));
    await pushEvent(
      service,
      "CP-B",
      logEvent('Received: [2,"b-1","Reset",{"type":"Soft"}]'),
    );
    await pushEvent(
      service,
      "CP-B",
      logEvent("SOAP POST Heartbeat: <Envelope/>", LogType.OCPP),
    );
    await flush(10);

    expect(container.textContent).toContain(
      "Other log lines and SOAP exchanges stay in the Log tab.",
    );
    // One frame per charge point: the other lines are not trace entries.
    expect(filterOptions(container, "Charge points")).toEqual([
      "CP-A (1): true",
      "CP-B (1): false",
    ]);
    expect(filterOptions(container, "Actions")).toEqual([
      "Heartbeat (1): false",
      "Reset (1): false",
    ]);
    for (const label of ["Export filtered", "Export selection"]) {
      expect(
        Array.from(container.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === label,
        ),
      ).toBe(true);
    }
  });

  it("writes a charge point picked in the trace view to the URL", async () => {
    const { container, service, locations } = await mount("/logs?view=trace");
    await flush(10);
    await pushEvent(
      service,
      "CP-B",
      logEvent('Sent: [2,"b-1","Heartbeat",{}]'),
    );
    await flush(10);

    const option = Array.from(
      container.querySelectorAll<HTMLLabelElement>(".oot-filter-group label"),
    ).find((label) => label.textContent?.trim().startsWith("CP-B"));
    await act(async () => {
      option?.querySelector("input")?.click();
    });
    await flush();

    expect(locations.at(-1)?.search).toBe("?view=trace&cp=CP-B");
  });
});
