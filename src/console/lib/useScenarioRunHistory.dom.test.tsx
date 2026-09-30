// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ScenarioRunPage,
  ScenarioRunQuery,
} from "../../cp/application/verification/ScenarioRunSummary";
import { DataContext } from "../../data/providers/DataProvider";
import {
  createFakeChargePointService,
  flush,
  pushEvent,
  type FakeChargePointService,
} from "../test/harness";
import { scenarioRunSummary } from "../../test/scenarioRunFixtures";
import { useScenarioRunHistory } from "./useScenarioRunHistory";

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const summary = (runId: string) => scenarioRunSummary({ runId });

type HookResult = ReturnType<typeof useScenarioRunHistory>;

function Probe({
  query,
  watch,
  onSnapshot,
}: {
  query: ScenarioRunQuery | null;
  watch: string[];
  onSnapshot: (snap: HookResult) => void;
}) {
  onSnapshot(useScenarioRunHistory(query, watch));
  return null;
}

let root: Root | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = null;
  }
});

async function mount(
  service: FakeChargePointService,
  query: ScenarioRunQuery | null,
  opts: { watch?: string[]; mode?: "local" | "remote" } = {},
): Promise<{
  current: () => HookResult;
  rerender: (query: ScenarioRunQuery | null) => Promise<void>;
}> {
  const container = document.createElement("div");
  const created = createRoot(container);
  root = created;
  let latest: HookResult | null = null;
  const render = (q: ScenarioRunQuery | null) =>
    created.render(
      <DataContext.Provider
        value={{
          mode: opts.mode ?? "remote",
          serverUrl: "http://test",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service,
        }}
      >
        <Probe
          query={q}
          watch={opts.watch ?? []}
          onSnapshot={(snap) => {
            latest = snap;
          }}
        />
      </DataContext.Provider>,
    );
  await act(async () => render(query));
  await flush();
  return {
    current: () => {
      if (!latest) throw new Error("no snapshot yet");
      return latest;
    },
    rerender: async (q) => {
      await act(async () => render(q));
      await flush();
    },
  };
}

describe("useScenarioRunHistory (#388)", () => {
  it("lists the daemon's runs for the query", async () => {
    const page: ScenarioRunPage = { runs: [summary("r1")], total: 1 };
    const listScenarioRuns = vi.fn(async () => page);
    const service = createFakeChargePointService({ listScenarioRuns });

    const hook = await mount(service, { cpId: "CP-1", scenarioId: "s1" });

    expect(listScenarioRuns).toHaveBeenCalledWith({
      cpId: "CP-1",
      scenarioId: "s1",
    });
    expect(hook.current().page).toEqual(page);
    expect(hook.current().supported).toBe(true);
  });

  it("re-lists, debounced, when a watched charge point records a run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listScenarioRuns = vi
      .fn()
      .mockResolvedValueOnce({ runs: [], total: 0 })
      .mockResolvedValue({ runs: [summary("r1")], total: 1 });
    const service = createFakeChargePointService({ listScenarioRuns });
    const hook = await mount(service, { cpId: "CP-1" }, { watch: ["CP-1"] });
    expect(hook.current().page.total).toBe(0);

    await pushEvent(service, "CP-1", {
      type: "scenario-run-recorded",
      connectorId: 1,
      scenarioId: "s1",
      runId: "r1",
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-run-recorded",
      connectorId: 1,
      scenarioId: "s1",
      runId: "r1",
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();

    expect(listScenarioRuns).toHaveBeenCalledTimes(2);
    expect(hook.current().page.runs.map((r) => r.runId)).toEqual(["r1"]);
  });

  it("keeps its event subscriptions when only the query changes", async () => {
    const service = createFakeChargePointService({
      listScenarioRuns: vi.fn(async () => ({ runs: [], total: 0 })),
    });
    const hook = await mount(
      service,
      { scenarioId: "a" },
      { watch: ["CP-1", "CP-2"] },
    );
    expect(service.subscribe).toHaveBeenCalledTimes(2);

    await hook.rerender({ scenarioId: "b" });

    expect(service.subscribe).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "a charge point is deleted",
      { type: "change", change: "removed", cp: { id: "CP-1" } },
    ],
    ["the simulator state is reset", { type: "change", change: "reset" }],
  ])("re-lists when %s", async (_, registryEvent) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listScenarioRuns = vi
      .fn()
      .mockResolvedValueOnce({ runs: [summary("r1")], total: 1 })
      .mockResolvedValue({ runs: [], total: 0 });
    const service = createFakeChargePointService({ listScenarioRuns });
    // Filtered on the charge point: its watch list does not change when the
    // registry does, so only the registry event can trigger the re-list.
    const hook = await mount(service, { cpId: "CP-1" }, { watch: ["CP-1"] });
    expect(hook.current().page.total).toBe(1);

    await act(async () => {
      service.__handlers.subscribeRegistry.forEach((handler) =>
        handler(registryEvent),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();

    expect(listScenarioRuns).toHaveBeenCalledTimes(2);
    expect(hook.current().page).toEqual({ runs: [], total: 0 });
  });

  it("does not re-list when a charge point is only updated", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listScenarioRuns = vi.fn(async () => ({ runs: [], total: 0 }));
    const service = createFakeChargePointService({ listScenarioRuns });
    await mount(service, {}, { watch: ["CP-1"] });

    await act(async () => {
      service.__handlers.subscribeRegistry.forEach((handler) =>
        handler({ type: "change", change: "updated", cp: { id: "CP-1" } }),
      );
      vi.advanceTimersByTime(250);
    });

    expect(listScenarioRuns).toHaveBeenCalledTimes(1);
  });

  it("ignores a run recorded outside the query", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listScenarioRuns = vi.fn(async () => ({ runs: [], total: 0 }));
    const service = createFakeChargePointService({ listScenarioRuns });
    await mount(
      service,
      { cpId: "CP-1", connectorId: 1, scenarioId: "s1" },
      { watch: ["CP-1"] },
    );

    await pushEvent(service, "CP-1", {
      type: "scenario-run-recorded",
      connectorId: 1,
      scenarioId: "other",
      runId: "other#1",
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-run-recorded",
      connectorId: 2,
      scenarioId: "s1",
      runId: "s1#9",
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(listScenarioRuns).toHaveBeenCalledTimes(1);
  });

  it("ignores a response that settles after the query changed", async () => {
    let resolveStale: (page: ScenarioRunPage) => void = () => {};
    const listScenarioRuns = vi.fn(
      (query: ScenarioRunQuery): Promise<ScenarioRunPage> =>
        query.scenarioId === "old"
          ? new Promise((resolve) => {
              resolveStale = resolve;
            })
          : Promise.resolve({ runs: [summary("new-run")], total: 1 }),
    );
    const service = createFakeChargePointService({ listScenarioRuns });
    const hook = await mount(service, { scenarioId: "old" });

    await hook.rerender({ scenarioId: "new" });
    await act(async () => {
      resolveStale({ runs: [summary("old-run")], total: 1 });
    });
    await flush();

    expect(hook.current().page.runs.map((r) => r.runId)).toEqual(["new-run"]);
  });

  it("reports an empty page when the service answers nothing", async () => {
    const service = createFakeChargePointService();
    const hook = await mount(service, {});
    expect(hook.current().page).toEqual({ runs: [], total: 0 });
    expect(hook.current().error).toBeNull();
  });

  it("surfaces a failed listing as an error", async () => {
    const service = createFakeChargePointService({
      listScenarioRuns: vi.fn(async () => {
        throw new Error("daemon down");
      }),
    });
    const hook = await mount(service, {});
    expect(hook.current().error).toContain("daemon down");
  });

  it("does not ask in local mode, which records no runs", async () => {
    const listScenarioRuns = vi.fn();
    const service = createFakeChargePointService({ listScenarioRuns });
    const hook = await mount(service, {}, { mode: "local" });
    expect(listScenarioRuns).not.toHaveBeenCalled();
    expect(hook.current().supported).toBe(false);
  });

  it("does not ask without a query", async () => {
    const listScenarioRuns = vi.fn();
    const service = createFakeChargePointService({ listScenarioRuns });
    await mount(service, null);
    expect(listScenarioRuns).not.toHaveBeenCalled();
  });
});
