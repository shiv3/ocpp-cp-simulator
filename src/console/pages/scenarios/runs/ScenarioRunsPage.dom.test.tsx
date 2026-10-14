// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ScenarioRunSummary } from "../../../../cp/application/verification/ScenarioRunSummary";
import type { ChargePointSnapshot } from "../../../../data/interfaces/ChargePointService";
import { scenarioRunSummary } from "../../../../test/scenarioRunFixtures";
import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../../test/harness";

/**
 * #388: the run history page — every recorded run, filtered and paged by the
 * daemon (`scenario.runs.list`), with the selected run's report beside it.
 */

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

function summary(
  runId: string,
  overrides: Partial<ScenarioRunSummary> = {},
): ScenarioRunSummary {
  return {
    ...scenarioRunSummary({ runId, scenarioName: "Boot demo" }),
    ...overrides,
  };
}

const snapshots = [
  { id: "CP-1" },
  { id: "CP-2" },
] as unknown as ChargePointSnapshot[];

function lastQuery(fn: unknown): unknown {
  const calls = vi.mocked(fn as (q: unknown) => unknown).mock.calls;
  return calls[calls.length - 1]?.[0];
}

function select(container: HTMLElement, label: string): HTMLSelectElement {
  const el = container.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`no select "${label}"`);
  return el;
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}

describe("ScenarioRunsPage (#388)", () => {
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

  it("lists every recorded run, newest first, with its target", async () => {
    const listScenarioRuns = vi.fn(async () => ({
      runs: [summary("r2", { cpId: "CP-2", verdict: "FAIL" }), summary("r1")],
      total: 2,
    }));
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
    });
    const { container, root } = await renderConsole("/scenarios/runs", {
      service,
    });
    cleanup = () => unmount(root);
    await flush();

    expect(lastQuery(listScenarioRuns)).toEqual({ limit: 50, offset: 0 });
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-run-id]"),
    ).map((el) => el.dataset.runId);
    expect(rows).toEqual(["r2", "r1"]);
    expect(container.textContent).toContain("CP-2 · C1 · Boot demo");
    expect(container.textContent).toContain("2 runs");
  });

  it("forwards the URL filters, and a changed filter, to the daemon", async () => {
    const listScenarioRuns = vi.fn(async () => ({ runs: [], total: 0 }));
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
    });
    const { container, root } = await renderConsole(
      "/scenarios/runs?cp=CP-1&connector=2&scenario=s1&state=error",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(lastQuery(listScenarioRuns)).toEqual({
      cpId: "CP-1",
      connectorId: 2,
      scenarioId: "s1",
      executionState: "error",
      limit: 50,
      offset: 0,
    });

    await choose(select(container, "Filter by verdict"), "FAIL");
    expect(lastQuery(listScenarioRuns)).toMatchObject({
      cpId: "CP-1",
      verdict: "FAIL",
    });

    await choose(select(container, "Filter by charge point"), "");
    expect(lastQuery(listScenarioRuns)).not.toHaveProperty("cpId");
    expect(container.textContent).toContain("No runs match these filters.");
  });

  it("pages through the history", async () => {
    const total = 120;
    const listScenarioRuns = vi.fn(
      async ({
        limit = 50,
        offset = 0,
      }: {
        limit?: number;
        offset?: number;
      }) => ({
        runs: Array.from(
          { length: Math.max(0, Math.min(limit, total - offset)) },
          (_, i) => summary(`r${offset + i}`),
        ),
        total,
      }),
    );
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
    });
    const { container, root } = await renderConsole("/scenarios/runs", {
      service,
    });
    cleanup = () => unmount(root);
    await flush();

    expect(button(container, "Previous").disabled).toBe(true);
    await act(async () => {
      button(container, "Next").click();
    });
    await flush();
    expect(lastQuery(listScenarioRuns)).toEqual({ limit: 50, offset: 50 });
    expect(container.textContent).toContain("51–100 of 120");

    await act(async () => {
      button(container, "Next").click();
    });
    await flush();
    expect(lastQuery(listScenarioRuns)).toEqual({ limit: 50, offset: 100 });
    expect(button(container, "Next").disabled).toBe(true);
  });

  it("goes back to the first page when a filter changes, in one query", async () => {
    const listScenarioRuns = vi.fn(
      async ({
        limit = 50,
        offset = 0,
      }: {
        limit?: number;
        offset?: number;
      }) => ({
        runs: Array.from({ length: Math.min(limit, 120 - offset) }, (_, i) =>
          summary(`r${offset + i}`),
        ),
        total: 120,
      }),
    );
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
    });
    const { container, root } = await renderConsole("/scenarios/runs", {
      service,
    });
    cleanup = () => unmount(root);
    await flush();
    await act(async () => {
      button(container, "Next").click();
    });
    await flush();
    listScenarioRuns.mockClear();

    await choose(select(container, "Filter by verdict"), "FAIL");

    expect(listScenarioRuns.mock.calls.map(([q]) => q)).toEqual([
      { verdict: "FAIL", limit: 50, offset: 0 },
    ]);
  });

  it("steps back to the last page when the history shrinks under it", async () => {
    let total = 120;
    const listScenarioRuns = vi.fn(
      async ({
        limit = 50,
        offset = 0,
      }: {
        limit?: number;
        offset?: number;
      }) => ({
        runs: Array.from(
          { length: Math.max(0, Math.min(limit, total - offset)) },
          (_, i) => summary(`r${offset + i}`),
        ),
        total,
      }),
    );
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
    });
    const { container, root } = await renderConsole("/scenarios/runs", {
      service,
    });
    cleanup = () => unmount(root);
    await flush();
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        button(container, "Next").click();
      });
      await flush();
    }
    expect(lastQuery(listScenarioRuns)).toMatchObject({ offset: 100 });

    total = 40;
    await act(async () => {
      button(container, "Refresh").click();
    });
    await flush();

    expect(lastQuery(listScenarioRuns)).toMatchObject({ offset: 0 });
    expect(container.textContent).toContain("1–40 of 40");
  });

  it("opens the report of the run named in the URL", async () => {
    const getScenarioReport = vi.fn(async () => null);
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns: vi.fn(async () => ({
        runs: [summary("r1", { cpId: "CP-2", connectorId: 3 })],
        total: 1,
      })),
      getScenarioReport,
    });
    const { container, root } = await renderConsole("/scenarios/runs?run=r1", {
      service,
    });
    cleanup = () => unmount(root);
    await flush();

    expect(getScenarioReport).toHaveBeenCalledWith("CP-2", 3, "s1", "r1");
    expect(
      container
        .querySelector('[data-run-id="r1"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain(
      "The report for run r1 is no longer available.",
    );
  });

  it("reopens a copied URL for a run beyond the first page", async () => {
    // 130 runs, newest first: r0 … r129. r120 is on the third page.
    const total = 130;
    const listScenarioRuns = vi.fn(
      async (query: { runId?: string; limit?: number; offset?: number }) => {
        if (query.runId) {
          return {
            runs: [summary(query.runId, { cpId: "CP-2", connectorId: 3 })],
            total: 1,
          };
        }
        const { limit = 50, offset = 0 } = query;
        return {
          runs: Array.from(
            { length: Math.max(0, Math.min(limit, total - offset)) },
            (_, i) => summary(`r${offset + i}`),
          ),
          total,
        };
      },
    );
    const getScenarioReport = vi.fn(async () => null);
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
      getScenarioReport,
    });
    const { container, root } = await renderConsole(
      "/scenarios/runs?run=r120",
      {
        service,
      },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(listScenarioRuns).toHaveBeenCalledWith({ runId: "r120", limit: 2 });
    expect(getScenarioReport).toHaveBeenCalledWith("CP-2", 3, "s1", "r120");
    expect(container.textContent).toContain(
      "The report for run r120 is no longer available.",
    );
  });

  it("reads the page from the URL, so a copied page reopens on it", async () => {
    const total = 120;
    const listScenarioRuns = vi.fn(
      async ({
        runId,
        limit = 50,
        offset = 0,
      }: {
        runId?: string;
        limit?: number;
        offset?: number;
      }) =>
        runId
          ? { runs: [summary(runId)], total: 1 }
          : {
              runs: Array.from(
                { length: Math.max(0, Math.min(limit, total - offset)) },
                (_, i) => summary(`r${offset + i}`),
              ),
              total,
            },
    );
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
    });
    const { container, root } = await renderConsole(
      "/scenarios/runs?offset=50&run=r60",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    // The page, then the uniqueness check a link without `runCp` needs.
    expect(listScenarioRuns.mock.calls.map(([q]) => q)).toEqual([
      { limit: 50, offset: 50 },
      { runId: "r60", limit: 2 },
    ]);
    expect(container.textContent).toContain("51–100 of 120");
    expect(
      container
        .querySelector('[data-run-id="r60"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  describe("two charge points sharing a runId", () => {
    // A runId is unique per charge point only.
    const shared = [
      summary("dup#1", { cpId: "CP-1", connectorId: 1 }),
      summary("dup#1", { cpId: "CP-2", connectorId: 3 }),
    ];

    /** The page lists `onPage`; a `runId` lookup searches `shared`. */
    function serviceListing(onPage: ScenarioRunSummary[]) {
      const listScenarioRuns = vi.fn(
        async (query: { runId?: string; cpId?: string; limit?: number }) => {
          if (query.runId === undefined) {
            return { runs: onPage, total: onPage.length };
          }
          const found = shared.filter(
            (r) =>
              r.runId === query.runId &&
              (query.cpId === undefined || r.cpId === query.cpId),
          );
          return { runs: found.slice(0, query.limit), total: found.length };
        },
      );
      const getScenarioReport = vi.fn(async () => null);
      const service = createFakeChargePointService({
        snapshots,
        listScenarioRuns,
        getScenarioReport,
      });
      return { service, listScenarioRuns, getScenarioReport };
    }

    const row = (container: HTMLElement, cpId: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-run-id="dup#1"][data-cp-id="${cpId}"]`,
      );

    it("keeps both rows apart and opens the report of the one clicked", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { service, getScenarioReport } = serviceListing(shared);
      const { container, root } = await renderConsole("/scenarios/runs", {
        service,
      });
      cleanup = async () => {
        errors.mockRestore();
        await unmount(root);
      };
      await flush();

      expect(row(container, "CP-1")).not.toBeNull();
      expect(row(container, "CP-2")).not.toBeNull();
      expect(
        errors.mock.calls.some((args) => String(args[0]).includes("same key")),
      ).toBe(false);

      await act(async () => {
        row(container, "CP-2")!.click();
      });
      await flush();

      expect(getScenarioReport).toHaveBeenLastCalledWith(
        "CP-2",
        3,
        "s1",
        "dup#1",
      );
      expect(row(container, "CP-2")!.getAttribute("aria-pressed")).toBe("true");
      expect(row(container, "CP-1")!.getAttribute("aria-pressed")).toBe(
        "false",
      );
    });

    it("reopens a copied link on the charge point it names, on the page", async () => {
      const { service, getScenarioReport } = serviceListing(shared);
      const { container, root } = await renderConsole(
        "/scenarios/runs?run=dup%231&runCp=CP-2",
        { service },
      );
      cleanup = () => unmount(root);
      await flush();

      expect(getScenarioReport).toHaveBeenCalledWith("CP-2", 3, "s1", "dup#1");
      expect(getScenarioReport).not.toHaveBeenCalledWith(
        "CP-1",
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(row(container, "CP-2")!.getAttribute("aria-pressed")).toBe("true");
    });

    it("reopens a copied link on the charge point it names, off the page", async () => {
      const { service, listScenarioRuns, getScenarioReport } = serviceListing(
        [],
      );
      const { root } = await renderConsole(
        "/scenarios/runs?run=dup%231&runCp=CP-2",
        { service },
      );
      cleanup = () => unmount(root);
      await flush();

      expect(listScenarioRuns).toHaveBeenCalledWith({
        runId: "dup#1",
        cpId: "CP-2",
        limit: 2,
      });
      expect(getScenarioReport).toHaveBeenCalledWith("CP-2", 3, "s1", "dup#1");
    });

    it("opens no report for a link without runCp when the other match is on another page", async () => {
      // CP-1's run is on this page, CP-2's is not: the id is still ambiguous.
      const { service, listScenarioRuns, getScenarioReport } = serviceListing([
        shared[0],
      ]);
      const { container, root } = await renderConsole(
        "/scenarios/runs?run=dup%231",
        { service },
      );
      cleanup = () => unmount(root);
      await flush();

      expect(listScenarioRuns).toHaveBeenCalledWith({
        runId: "dup#1",
        limit: 2,
      });
      expect(getScenarioReport).not.toHaveBeenCalled();
      expect(row(container, "CP-1")!.getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(container.textContent).toContain(
        "Run dup#1 was recorded on several charge points",
      );
    });

    it("opens no report for a link that names no charge point and matches two", async () => {
      const { service, getScenarioReport } = serviceListing([]);
      const { container, root } = await renderConsole(
        "/scenarios/runs?run=dup%231",
        { service },
      );
      cleanup = () => unmount(root);
      await flush();

      expect(getScenarioReport).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        "Run dup#1 was recorded on several charge points",
      );
    });
  });

  it("explains that local mode keeps no run history", async () => {
    const listScenarioRuns = vi.fn();
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns,
    });
    const { container, root } = await renderConsole("/scenarios/runs", {
      service,
      mode: "local",
    });
    cleanup = () => unmount(root);
    await flush();

    expect(listScenarioRuns).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Run history needs the simulator daemon",
    );
  });

  it("is reachable from the sidebar, which lights it instead of Scenarios", async () => {
    const service = createFakeChargePointService({
      snapshots,
      listScenarioRuns: vi.fn(async () => ({ runs: [], total: 0 })),
    });
    const { container, root } = await renderConsole("/scenarios/runs", {
      service,
    });
    cleanup = () => unmount(root);
    await flush();

    const nav = (label: string) =>
      Array.from(container.querySelectorAll("aside a")).find(
        (a) => a.textContent?.trim() === label,
      );
    expect(nav("Run History")?.getAttribute("href")).toBe("/scenarios/runs");
    expect(nav("Run History")?.getAttribute("aria-current")).toBe("page");
    expect(nav("Scenarios")?.getAttribute("aria-current")).toBeNull();
  });
});
