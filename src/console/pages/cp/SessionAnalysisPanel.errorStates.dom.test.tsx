// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// CodeRabbit finding (issue #188, Minor): the panel's two error branches --
// (a) a successfully-loaded toolkit whose pipeline (parseOpenOcppTrace ->
// buildSessionTimeline -> detectFailures -> summarizeSessions) throws, and
// (b) the toolkit's own dynamic `import("@ocpp-debugkit/toolkit/core")`
// itself failing to load -- had no test coverage. Both need
// `@ocpp-debugkit/toolkit/core` to misbehave, which vi.mock's hoisting
// handles for a dynamic `import()` exactly like a static one (same
// technique as
// src/cli/analyze/__tests__/runAnalyze.toolkitFailure.test.ts). Kept out of
// SessionAnalysisPanel.dom.test.tsx so that file's tests keep exercising the
// real toolkit.
//
// (a) is a single hoisted vi.mock, delegating to the real implementation
// unless the trace text carries the "CP-PIPELINE-FAIL" marker (mirrors the
// CLI precedent's per-group "CP-BAD" marker) -- a call-time check, so it
// coexists with every other test in this file that wants the real
// implementation. (b) needs the dynamic `import()` itself to reject, which
// -- once a module has resolved for a given specifier -- can't be flipped
// per-test without resetting the module registry; it uses `vi.doMock` +
// `vi.resetModules()` and re-imports the harness fresh, isolated to that one
// test (last in the file, so nothing after it depends on the pre-reset
// module graph).
vi.mock("@ocpp-debugkit/toolkit/core", async () => {
  const actual = await vi.importActual<
    typeof import("@ocpp-debugkit/toolkit/core")
  >("@ocpp-debugkit/toolkit/core");
  return {
    ...actual,
    parseOpenOcppTrace: (jsonl: string) => {
      if (jsonl.includes("CP-PIPELINE-FAIL")) {
        throw new Error("simulated toolkit pipeline failure");
      }
      return actual.parseOpenOcppTrace(jsonl);
    },
  };
});

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

/** See SessionAnalysisPanel.dom.test.tsx for why `getStateHistory` is
 *  stubbed on every service built here. */
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

function logRow(timestamp: string, message: string): StoredLogEntry {
  return { timestamp, level: "INFO", type: "WebSocket", cpId: "CP-1", message };
}

// `logLinesToTrace` stamps this trace's derived records with the "CP-1"
// chargePointId (from the `chargePointId` option passed by the panel), not
// the marker string -- so the marker has to live in the wire payload itself
// (an idTag) to land in the jsonl text the mocked `parseOpenOcppTrace` sees.
const PIPELINE_FAIL_ROWS = [
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
    'Sent: [2,"2","Authorize",{"idTag":"CP-PIPELINE-FAIL"}]',
  ),
  logRow(
    "2026-01-01T00:00:03.000Z",
    'Received: [3,"2",{"idTagInfo":{"status":"Accepted"}}]',
  ),
];

describe("SessionAnalysisPanel (pipeline failure after a successful toolkit load)", () => {
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

  it("shows 'Analysis failed: <msg>' and keeps the Analyze button as a retry affordance", async () => {
    const service = makeService({
      snapshots: [snapshot("CP-1")],
      listStoredLogs: vi.fn(async () => PIPELINE_FAIL_ROWS),
    });
    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);
    await clickAnalyzeAndWait(container);

    expect(container.textContent).toContain(
      "Analysis failed: simulated toolkit pipeline failure",
    );

    // Retry affordance: the Analyze button is still present and enabled
    // (not stuck disabled/"Analyzing…") so the user can just click again.
    const retryButton = findButton(container, "Analyze");
    expect(retryButton, "expected the Analyze button to remain").toBeTruthy();
    expect(retryButton!.disabled).toBe(false);
  });
});

describe("SessionAnalysisPanel (toolkit-load failure)", () => {
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

  it("shows 'Failed to load analysis toolkit' when the dynamic import itself rejects", async () => {
    // Once `import("@ocpp-debugkit/toolkit/core")` has resolved for a given
    // specifier, later `import()` calls of it in this file get the same
    // cached (fulfilled) module -- so making it reject here (while the
    // sibling describe block above needs it to resolve) requires swapping
    // the registered factory and clearing the module registry, then
    // re-importing the harness (and, transitively, the panel) fresh so the
    // new dynamic import call actually observes the swapped factory. This
    // is isolated to this one test (the last in the file).
    vi.resetModules();
    vi.doMock("@ocpp-debugkit/toolkit/core", () => {
      throw new Error("simulated toolkit load failure");
    });

    const harness = await import("../../test/harness");
    const service = harness.createFakeChargePointService({
      getStateHistory: vi.fn(async () => []),
      snapshots: [snapshot("CP-1")],
      listStoredLogs: vi.fn(async () => PIPELINE_FAIL_ROWS),
    });
    const { container, root } = await harness.renderConsole("/cp/CP-1", {
      service,
    });
    cleanup = () => unmount(root);
    await flush();
    await openAnalysisTab(container);
    await clickAnalyzeAndWait(container);

    expect(container.textContent).toContain("Failed to load analysis toolkit");

    const retryButton = findButton(container, "Analyze");
    expect(retryButton, "expected the Analyze button to remain").toBeTruthy();
    expect(retryButton!.disabled).toBe(false);
  });
});
