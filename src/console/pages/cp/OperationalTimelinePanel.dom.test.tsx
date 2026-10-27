// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  pushEvent,
  renderConsole,
  type FakeChargePointService,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { LogType } from "../../../cp/shared/Logger";
import type {
  TimelineEntry,
  TimelinePage,
} from "../../../cp/application/services/OperationalTimeline";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";

/** #448: the CP page's "Operational events" tab renders the timeline. */

function makeService(
  overrides: Partial<ChargePointService> & {
    snapshots?: ChargePointSnapshot[];
  },
): FakeChargePointService {
  return createFakeChargePointService({
    snapshots: [
      { id: "CP-1", status: OCPPStatus.Available, error: "", connectors: [] },
    ],
    getStateHistory: vi.fn(async () => []),
    ...overrides,
  });
}

let seq = 0;
function entry(
  kind: TimelineEntry["kind"],
  summary: string,
  extra: Partial<TimelineEntry> = {},
): TimelineEntry {
  seq += 1;
  return {
    seq,
    timestamp: new Date(Date.UTC(2026, 9, 27, 15, 21, seq)).toISOString(),
    kind,
    cpId: "CP-1",
    summary,
    data: {},
    ...extra,
  };
}

const page = (entries: TimelineEntry[]): TimelinePage => ({
  entries,
  total: entries.length,
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const rows = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="timeline-row"]'),
  );

describe("OperationalTimelinePanel", () => {
  let root: Root | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("is a tab that renders the timeline in order, incidents marked", async () => {
    const getOperationalTimeline = vi.fn(async () =>
      page([
        entry("connector_status", "Connector 1 Unavailable → Available", {
          connectorId: 1,
        }),
        entry("network_fault_injected", "Network fault injected by rule cut", {
          incidentId: "inc-1",
        }),
        entry("disconnected", "Disconnected (code 1006)", {
          incidentId: "inc-1",
        }),
        entry("recovery_completed", "Recovered in 41 s after rule cut", {
          incidentId: "inc-1",
          data: { durationMs: 41_000, ruleId: "cut" },
        }),
      ]),
    );
    const service = makeService({ getOperationalTimeline });
    const rendered = await renderConsole("/cp/CP-1", { service });
    root = rendered.root;
    const { container } = rendered;

    const tab = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[role="tablist"][aria-label="Charge point sections"] [role="tab"]',
      ),
    ).find((t) => t.textContent?.trim() === "Operational events");
    expect(tab, "expected an Operational events tab").toBeTruthy();
    await act(async () => tab!.click());
    await waitFor(() => rows(container).length === 4, "timeline rows");

    expect(getOperationalTimeline).toHaveBeenCalledWith("CP-1", undefined);
    expect(rows(container).map((r) => r.dataset.kind)).toEqual([
      "connector_status",
      "network_fault_injected",
      "disconnected",
      "recovery_completed",
    ]);
    expect(rows(container).map((r) => r.dataset.incident ?? null)).toEqual([
      null,
      "inc-1",
      "inc-1",
      "inc-1",
    ]);
    expect(rows(container)[3]!.textContent).toContain("Recovered in 41 s");
  });

  it("opens from a ?tab=events deep link and links a scenario entry to its run", async () => {
    const service = makeService({
      getOperationalTimeline: vi.fn(async () =>
        page([
          entry("scenario_started", "Scenario s1 started", {
            connectorId: 1,
            runId: "s1#1-a",
            data: { scenarioId: "s1" },
          }),
        ]),
      ),
    });
    const rendered = await renderConsole("/cp/CP-1?tab=events", { service });
    root = rendered.root;
    const { container } = rendered;
    await waitFor(() => rows(container).length === 1, "timeline rows");

    const link = rows(container)[0]!.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "/scenarios/runs?run=s1%231-a&runCp=CP-1",
    );
  });

  it("re-reads the timeline when the charge point reports an event", async () => {
    const getOperationalTimeline = vi
      .fn<NonNullable<ChargePointService["getOperationalTimeline"]>>()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValue(page([entry("connected", "Connected")]));
    const service = makeService({ getOperationalTimeline });
    const rendered = await renderConsole("/cp/CP-1?tab=events", { service });
    root = rendered.root;
    const { container } = rendered;
    await waitFor(
      () => container.textContent?.includes("No operational events") ?? false,
      "empty state",
    );

    await pushEvent(service, "CP-1", { type: "connected" });
    await waitFor(() => rows(container).length === 1, "refreshed rows");
    expect(getOperationalTimeline).toHaveBeenCalledTimes(2);
  });

  it("does not re-read on log lines", async () => {
    const getOperationalTimeline = vi.fn(async () => page([]));
    const service = makeService({ getOperationalTimeline });
    const rendered = await renderConsole("/cp/CP-1?tab=events", { service });
    root = rendered.root;
    await waitFor(
      () => getOperationalTimeline.mock.calls.length === 1,
      "first read",
    );

    await pushEvent(service, "CP-1", {
      type: "log",
      entry: {
        timestamp: new Date(),
        level: 1,
        type: LogType.OCPP,
        message: "x",
      },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(getOperationalTimeline).toHaveBeenCalledTimes(1);
  });

  it("shows a read failure instead of an empty timeline", async () => {
    const service = makeService({
      getOperationalTimeline: vi.fn(async () => {
        throw new Error("daemon unreachable");
      }),
    });
    const rendered = await renderConsole("/cp/CP-1?tab=events", { service });
    root = rendered.root;
    const { container } = rendered;

    await waitFor(
      () => container.textContent?.includes("daemon unreachable") ?? false,
      "error message",
    );
    expect(container.textContent).not.toContain("No operational events");
  });
});
