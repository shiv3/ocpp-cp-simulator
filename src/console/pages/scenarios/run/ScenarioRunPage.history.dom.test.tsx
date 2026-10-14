// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createEmptyScenario, insertStep } from "../../../lib/scenarioSteps";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../../../../cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "../../../../cp/application/verification/ScenarioAssertions";
import {
  summarizeRun,
  type ScenarioRunSummary,
} from "../../../../cp/application/verification/ScenarioRunSummary";
import { scenarioRunResult } from "../../../../test/scenarioRunFixtures";
import {
  createFakeChargePointService,
  flush,
  pushEvent,
  renderConsole,
} from "../../../test/harness";

/**
 * #388: the run page's history comes from the daemon's recorded runs, so it
 * survives navigating away and back, and a recorded run opens its report.
 */

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

function fixture(): ScenarioDefinition {
  let def = createEmptyScenario("Boot demo", "connector", 1);
  def = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
  return { ...def, id: "s1" };
}

function report(overrides: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  return scenarioRunResult({
    runId: "s1#100",
    scenarioName: "Boot demo",
    verdict: "FAIL",
    conformanceVerdict: "FAIL",
    assertions: [
      {
        id: "boot-sent",
        type: "ocpp_sent",
        status: "failed",
        description: "BootNotification is sent",
        detail: "never sent",
        severity: "failure",
      },
    ],
    transcript: [
      {
        seq: 0,
        ts: "2026-09-30T08:00:01.000Z",
        direction: "sent",
        kind: "call",
        uniqueId: "u-1",
        action: "StatusNotification",
        payload: { status: "Available" },
      },
    ],
    ...overrides,
  });
}

const PATH = "/scenarios/run?cp=CP-1&connector=1&id=s1";

describe("ScenarioRunPage run history (#388)", () => {
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

  function serviceWith(recorded: ScenarioRunSummary[]) {
    return createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture()]),
      listScenarioRuns: vi.fn(async () => ({
        runs: recorded,
        total: recorded.length,
      })),
      getScenarioReport: vi.fn(async () => report()),
    });
  }

  it("lists the recorded runs of this target, and still does after navigating back", async () => {
    const recorded = [summarizeRun(report())];
    const service = serviceWith(recorded);

    const first = await renderConsole(PATH, { service });
    await flush();
    expect(service.listScenarioRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        cpId: "CP-1",
        connectorId: 1,
        scenarioId: "s1",
      }),
    );
    expect(first.container.textContent).toContain("FAIL");
    expect(first.container.textContent).not.toContain("No runs");
    await unmount(first.root);

    const again = await renderConsole(PATH, { service });
    cleanup = () => unmount(again.root);
    await flush();
    expect(again.container.textContent).toContain("FAIL");
  });

  it("opens a recorded run's report: verdicts, assertions and transcript", async () => {
    const service = serviceWith([summarizeRun(report())]);
    const { container, root } = await renderConsole(PATH, { service });
    cleanup = () => unmount(root);
    await flush();

    const row = container.querySelector<HTMLButtonElement>(
      '[data-run-id="s1#100"]',
    );
    expect(row).not.toBeNull();
    await act(async () => {
      row!.click();
    });
    await flush();

    expect(service.getScenarioReport).toHaveBeenCalledWith(
      "CP-1",
      1,
      "s1",
      "s1#100",
    );
    const text = container.textContent ?? "";
    expect(text).toContain("boot-sent");
    expect(text).toContain("never sent");
    expect(text).toContain("StatusNotification");
    expect(text).toContain("u-1");
  });

  it("re-lists when the daemon records a run on this charge point", async () => {
    const service = serviceWith([]);
    const { root } = await renderConsole(PATH, { service });
    cleanup = () => unmount(root);
    await flush();
    const calls = vi.mocked(service.listScenarioRuns!).mock.calls.length;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await pushEvent(service, "CP-1", {
        type: "scenario-run-recorded",
        connectorId: 1,
        scenarioId: "s1",
        runId: "s1#101",
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(vi.mocked(service.listScenarioRuns!).mock.calls.length).toBe(
      calls + 1,
    );
  });

  it("links to the run history page filtered on this target", async () => {
    const service = serviceWith([]);
    const { container, root } = await renderConsole(PATH, { service });
    cleanup = () => unmount(root);
    await flush();

    const link = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "View all runs",
    );
    expect(link?.getAttribute("href")).toBe(
      "/scenarios/runs?cp=CP-1&connector=1&scenario=s1",
    );
  });

  it("keeps the session-only history in local mode", async () => {
    const service = serviceWith([summarizeRun(report())]);
    const { container, root } = await renderConsole(PATH, {
      service,
      mode: "local",
    });
    cleanup = () => unmount(root);
    await flush();

    expect(service.listScenarioRuns).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No runs yet this session.");
  });
});
