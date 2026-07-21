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
import type {
  ChargePointService,
  ChargePointSnapshot,
  StoredLogEntry,
} from "../../../data/interfaces/ChargePointService";
import { ANALYZE_DISCLAIMER } from "../../../trace/analysisDisclaimer";

/** `CpDetailPage` always renders `TransactionsTab` (the default active tab),
 *  whose `useStateHistory` crashes on the harness's auto-stubbed
 *  `getStateHistory` (resolves `undefined`, not `[]`) -- unrelated to this
 *  panel, so every test here supplies a real empty-array stub. */
function makeService(
  overrides: Partial<ChargePointService> & {
    snapshots?: ChargePointSnapshot[];
  },
): FakeChargePointService {
  return createFakeChargePointService({
    getStateHistory: vi.fn(async () => []),
    ...overrides,
  });
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

/** Flushes pending microtasks across a couple of ticks -- the lazy panel
 *  chunk's dynamic import, `listStoredLogs()`, and the toolkit's own
 *  dynamic `/core` import each add at least one hop. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function snapshot(id: string): ChargePointSnapshot {
  return { id, status: OCPPStatus.Available, error: "", connectors: [] };
}

function tabTrigger(
  container: HTMLElement,
  label: string,
): HTMLElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[role="tab"]'),
  ).find((el) => el.textContent?.trim() === label);
}

async function openAnalysisTab(container: HTMLElement): Promise<void> {
  const trigger = tabTrigger(container, "Session Analysis");
  expect(trigger, "expected a Session Analysis tab").toBeTruthy();
  // Radix's TabsTrigger switches on `onMouseDown`, not `onClick` -- plain
  // `.click()` only dispatches a "click" event, so it never activates it
  // (mirrors the dropdown-trigger workaround in CpDetailPage.dom.test.tsx).
  await act(async () => {
    trigger!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    await Promise.resolve();
  });
  // The panel is a lazy chunk (`import("./cp/SessionAnalysisPanel")`) that
  // itself statically pulls in the real `@ocpp-debugkit/toolkit/react`
  // package. The FIRST such import in a run does real (macrotask-bound)
  // module transform I/O, not just microtask hops, so a microtask-only
  // flush loop can spin forever without ever observing it resolve; poll
  // with a real `setTimeout` between checks instead of guessing a tick
  // count. Later tests in this file hit the same import already cached
  // and resolve on the first check.
  for (let i = 0; i < 100; i++) {
    if (!container.textContent?.includes("Loading session analysis")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("timed out waiting for SessionAnalysisPanel to load");
}

function findButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

/** Clicks "Analyze" and waits for the click handler's own dynamic
 *  `import("@ocpp-debugkit/toolkit/core")` to settle (button label reverts
 *  from "Analyzing..." once the analyzing/empty/results/error state
 *  transition lands). Same cold-import caveat as `openAnalysisTab`: real
 *  `setTimeout` polling, not a microtask-only flush. */
async function clickAnalyzeAndWait(container: HTMLElement): Promise<void> {
  const button = findButton(container, "Analyze");
  expect(button, "expected an Analyze button").toBeTruthy();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 200; i++) {
    if (!findButton(container, "Analyzing…")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("timed out waiting for Analyze to settle");
}

/** A wire-frame `Sent:`/`Received:` log row -- the shape `listStoredLogs`
 *  returns and `logLinesToTrace` (src/trace/logEntryToTrace.ts) parses. */
function logRow(timestamp: string, message: string): StoredLogEntry {
  return { timestamp, level: "INFO", type: "WebSocket", cpId: "CP-1", message };
}

const CLEAN_SESSION_ROWS = [
  logRow(
    "2026-01-01T00:00:00.000Z",
    'Sent: [2,"1","BootNotification",{"chargePointVendor":"V","chargePointModel":"M"}]',
  ),
  logRow(
    "2026-01-01T00:00:01.000Z",
    'Received: [3,"1",{"status":"Accepted","currentTime":"2026-01-01T00:00:01.000Z","interval":300}]',
  ),
  logRow("2026-01-01T00:00:02.000Z", 'Sent: [2,"2","Heartbeat",{}]'),
  logRow(
    "2026-01-01T00:00:03.000Z",
    'Received: [3,"2",{"currentTime":"2026-01-01T00:00:03.000Z"}]',
  ),
];

const FAILED_AUTH_ROWS = [
  logRow(
    "2026-01-01T00:00:00.000Z",
    'Sent: [2,"1","BootNotification",{"chargePointVendor":"V","chargePointModel":"M"}]',
  ),
  logRow(
    "2026-01-01T00:00:01.000Z",
    'Received: [3,"1",{"status":"Accepted","currentTime":"2026-01-01T00:00:01.000Z","interval":300}]',
  ),
  logRow(
    "2026-01-01T00:00:02.000Z",
    'Sent: [2,"2","Authorize",{"idTag":"TAG1"}]',
  ),
  logRow(
    "2026-01-01T00:00:03.000Z",
    'Received: [3,"2",{"idTagInfo":{"status":"Invalid"}}]',
  ),
];

const NON_WIRE_ROWS = [
  logRow("2026-01-01T00:00:00.000Z", "Scenario started: default-scenario"),
];

describe("SessionAnalysisPanel", () => {
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

  it("shows the Session Analysis tab (alongside the existing tabs) in idle state with the disclaimer and an Analyze button", async () => {
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs: vi.fn(async () => []),
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const labels = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).map((el) => el.textContent?.trim());
    expect(labels).toEqual([
      "Transactions",
      "Message Log",
      "Session Analysis",
      "Configuration",
      "Diagnostics",
    ]);

    await openAnalysisTab(container);

    expect(container.textContent).toContain(ANALYZE_DISCLAIMER);
    const analyzeButton = findButton(container, "Analyze");
    expect(analyzeButton, "expected an Analyze button").toBeTruthy();
    expect(analyzeButton!.disabled).toBe(false);
  });

  it("analyzes a clean session: timeline events render, FailureSummary says no failures, disclaimer stays visible", async () => {
    const listStoredLogs = vi.fn(async () => CLEAN_SESSION_ROWS);
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs,
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);

    await clickAnalyzeAndWait(container);

    expect(listStoredLogs).toHaveBeenCalledWith("CP-1");
    expect(container.textContent).toContain("BootNotification");
    expect(container.textContent).toContain("No failures detected");
    expect(container.textContent).toContain(ANALYZE_DISCLAIMER);
  });

  it("analyzes a failed-auth trace: FAILED_AUTHORIZATION is visible", async () => {
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs: vi.fn(async () => FAILED_AUTH_ROWS),
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);
    await clickAnalyzeAndWait(container);

    expect(container.textContent).toContain("FAILED_AUTHORIZATION");
  });

  it("clicking a timeline event shows it in the MessageInspector", async () => {
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs: vi.fn(async () => CLEAN_SESSION_ROWS),
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);
    await clickAnalyzeAndWait(container);

    expect(container.textContent).toContain("Select an event to inspect");

    const timelineItem = Array.from(container.querySelectorAll("li")).find(
      (el) => el.textContent?.includes("BootNotification"),
    );
    expect(
      timelineItem,
      "expected a BootNotification timeline row",
    ).toBeTruthy();

    await act(async () => {
      timelineItem!.click();
      await Promise.resolve();
    });
    await flush();

    expect(container.textContent).not.toContain("Select an event to inspect");
    expect(container.textContent).toContain("Message Inspector");
    // MessageInspector renders the action inline ("Action: BootNotification").
    expect(container.textContent).toContain("BootNotification");
  });

  it("shows the unavailable EmptyState (no Analyze button) when listStoredLogs is undefined", async () => {
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs: undefined,
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);

    expect(container.textContent).toContain(
      "Session analysis is not available in this runtime",
    );
    expect(findButton(container, "Analyze")).toBeUndefined();
  });

  it("shows 'No logged traffic to analyze yet' after clicking Analyze when listStoredLogs resolves []", async () => {
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs: vi.fn(async () => []),
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);
    await clickAnalyzeAndWait(container);

    expect(container.textContent).toContain(
      "No logged traffic to analyze yet.",
    );
  });

  it("shows 'No logged traffic to analyze yet' when the stored rows are all non-wire log lines", async () => {
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs: vi.fn(async () => NON_WIRE_ROWS),
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);
    await clickAnalyzeAndWait(container);

    expect(container.textContent).toContain(
      "No logged traffic to analyze yet.",
    );
  });
});
