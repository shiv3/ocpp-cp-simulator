// @vitest-environment jsdom
import { act } from "react";
import { cleanup as rtlCleanup, render } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
  type FakeChargePointService,
} from "../../test/harness";
import { DataContext } from "../../../data/providers/DataProvider";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
  StoredLogEntry,
} from "../../../data/interfaces/ChargePointService";
import { ANALYZE_DISCLAIMER } from "../../../trace/analysisDisclaimer";
import SessionAnalysisPanel from "./SessionAnalysisPanel";

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

/** Waits for the "Analyzing…" button label to revert (to "Analyze") once
 *  whatever async work is in flight settles into empty/results/error. Same
 *  cold-import caveat as `openAnalysisTab`: real `setTimeout` polling, not a
 *  microtask-only flush. */
async function waitForAnalyzeSettle(container: HTMLElement): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!findButton(container, "Analyzing…")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("timed out waiting for Analyze to settle");
}

/** Clicks "Analyze" and waits for the click handler's own dynamic
 *  `import("@ocpp-debugkit/toolkit/core")` to settle (button label reverts
 *  from "Analyzing..." once the analyzing/empty/results/error state
 *  transition lands). */
async function clickAnalyzeAndWait(container: HTMLElement): Promise<void> {
  const button = findButton(container, "Analyze");
  expect(button, "expected an Analyze button").toBeTruthy();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
  await waitForAnalyzeSettle(container);
}

/** A promise plus its externally-callable `resolve`, for tests that need to
 *  hold an in-flight `listStoredLogs()` call open deterministically (rather
 *  than racing against real timers) while they assert on the transient
 *  "analyzing" state or exercise a stale-prop scenario. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Renders `SessionAnalysisPanel` directly (not through the full console /
 *  lazy tab machinery) wrapped in just the `DataContext` it needs. Used by
 *  tests that need to change the `cpId` prop via `rerender` -- navigating
 *  `renderConsole` to a different CP route wouldn't remount or re-prop this
 *  lazy-loaded panel any differently than a plain prop change would, and
 *  this way avoids the lazy-chunk-load and tab-click choreography entirely. */
function renderPanel(
  props: { cpId: string; ocppVersion?: string },
  service: FakeChargePointService,
) {
  return render(
    <DataContext.Provider
      value={{
        mode: "remote",
        serverUrl: "http://test",
        defaultEvSettings: null,
        setDefaultEvSettings: () => {},
        chargePointService: service,
      }}
    >
      <SessionAnalysisPanel {...props} />
    </DataContext.Provider>,
  );
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

  it("analyzes a clean session: shows the transient analyzing state, then timeline events render, FailureSummary says no failures, disclaimer stays visible", async () => {
    const logs = deferred<StoredLogEntry[]>();
    const listStoredLogs = vi.fn(() => logs.promise);
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs,
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);

    const analyzeButton = findButton(container, "Analyze");
    expect(analyzeButton, "expected an Analyze button").toBeTruthy();
    await act(async () => {
      analyzeButton!.click();
      await Promise.resolve();
    });

    // Transient state: immediately after clicking, before `listStoredLogs`
    // (held open by the deferred promise) resolves.
    const analyzingButton = findButton(container, "Analyzing…");
    expect(
      analyzingButton,
      'expected the button to read "Analyzing…" while in flight',
    ).toBeTruthy();
    expect(analyzingButton!.disabled).toBe(true);

    await act(async () => {
      logs.resolve(CLEAN_SESSION_ROWS);
    });
    await waitForAnalyzeSettle(container);

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
    expect(container.textContent).toContain(ANALYZE_DISCLAIMER);
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

  it("guards against a stale cpId: an analyze started for the old CP does not render its results once the panel has moved on to a new CP", async () => {
    // `handleAnalyze` closes over `cpId`; nothing remounts the panel on a
    // `cpId` prop change alone (CpDetailPage keeps one lazy-loaded panel
    // instance across route param changes), so this renders the panel
    // directly (not through the full console) to change `cpId` via
    // `rerender` without unmounting -- exactly the scenario a stale async
    // result would otherwise leak into.
    const logsA = deferred<StoredLogEntry[]>();
    const listStoredLogsA = vi.fn(() => logsA.promise);
    const serviceA = makeService({
      snapshots: [snapshot("CP-A")],
      listStoredLogs: listStoredLogsA,
    });

    const { container, rerender } = renderPanel({ cpId: "CP-A" }, serviceA);
    cleanup = async () => rtlCleanup();

    const findAnalyze = () =>
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Analyze",
      ) as HTMLButtonElement | undefined;

    expect(findAnalyze(), "expected an Analyze button for CP-A").toBeTruthy();
    await act(async () => {
      findAnalyze()!.click();
      await Promise.resolve();
    });
    expect(listStoredLogsA).toHaveBeenCalledWith("CP-A");

    // CP-A's analyze is still in flight (listStoredLogsA's promise hasn't
    // resolved yet) when the panel is handed a different cpId -- e.g. the
    // user navigated to another charge point's detail page.
    const serviceB = makeService({ snapshots: [snapshot("CP-B")] });
    await act(async () => {
      rerender(
        <DataContext.Provider
          value={{
            mode: "remote",
            serverUrl: "http://test",
            defaultEvSettings: null,
            setDefaultEvSettings: () => {},
            chargePointService: serviceB,
          }}
        >
          <SessionAnalysisPanel cpId="CP-B" />
        </DataContext.Provider>,
      );
    });

    // The panel resets to idle for CP-B as soon as the prop changes --
    // it doesn't wait for CP-A's in-flight analyze to settle first.
    expect(
      findAnalyze(),
      "expected the panel to already be idle (Analyze button) for CP-B",
    ).toBeTruthy();
    expect(findAnalyze()!.disabled).toBe(false);

    // Now release CP-A's stale analyze. Its results must not leak onto
    // CP-B's now-rendered page.
    await act(async () => {
      logsA.resolve(CLEAN_SESSION_ROWS);
      await Promise.resolve();
    });
    await flush();

    expect(container.textContent).not.toContain("BootNotification");
    expect(container.textContent).not.toContain("No failures detected");
    expect(
      findAnalyze(),
      "expected the panel to remain idle for CP-B",
    ).toBeTruthy();
    expect(findAnalyze()!.disabled).toBe(false);
  });
});
