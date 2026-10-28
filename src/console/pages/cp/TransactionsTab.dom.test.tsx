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
import type { ChargingSession } from "../../../cp/domain/session/ChargingSession";
import { chargingSession } from "../../../test/chargingSessionFixtures";
import type { ChargingSessionPage } from "../../../cp/domain/persistence/ChargingSessionRepository";
import type { ChargePointService } from "../../../data/interfaces/ChargePointService";

/** #447: the CP page's "Transactions" tab lists the charging sessions. */

function makeService(
  overrides: Partial<ChargePointService>,
): FakeChargePointService {
  return createFakeChargePointService({
    snapshots: [
      { id: "CP-1", status: OCPPStatus.Available, error: "", connectors: [] },
    ],
    ...overrides,
  });
}

const session = chargingSession;

const page = (sessions: ChargingSession[]): ChargingSessionPage => ({
  sessions,
  total: sessions.length,
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
    container.querySelectorAll<HTMLElement>('[data-testid="session-row"]'),
  );

const cells = (row: HTMLElement) =>
  Array.from(row.querySelectorAll("td")).map((td) => td.textContent?.trim());

describe("TransactionsTab", () => {
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

  it("lists the sessions newest first, unknown values as a dash", async () => {
    const listChargingSessions = vi.fn(async () =>
      page([
        session({
          sessionId: "s-2",
          connectorId: 2,
          transactionId: null,
          idTag: null,
          startedAt: "2026-10-28T11:00:00.000Z",
          endedAt: null,
          durationMs: null,
          meterStopWh: null,
          energyWh: null,
          stopReason: null,
          outcome: "active",
        }),
        session(),
      ]),
    );
    const service = makeService({ listChargingSessions });
    const rendered = await renderConsole("/cp/CP-1?tab=transactions", {
      service,
    });
    root = rendered.root;
    const { container } = rendered;
    await waitFor(() => rows(container).length === 2, "session rows");

    expect(listChargingSessions).toHaveBeenCalledWith("CP-1", { limit: 50 });
    expect(rows(container).map((r) => r.dataset.outcome)).toEqual([
      "active",
      "completed",
    ]);
    const [active, completed] = rows(container).map(cells);
    expect(active!.slice(1)).toEqual(["2", "—", "—", "—", "—", "—", "active"]);
    expect(completed!.slice(1)).toEqual([
      "1",
      "42",
      "TAG-1",
      "25 m 30 s",
      "12.35 kWh",
      "Local",
      "completed",
    ]);
  });

  it("applies a pushed session: a known one in place, a new one on top", async () => {
    const service = makeService({
      listChargingSessions: vi.fn(async () =>
        page([session({ outcome: "active", endedAt: null })]),
      ),
    });
    const rendered = await renderConsole("/cp/CP-1?tab=transactions", {
      service,
    });
    root = rendered.root;
    const { container } = rendered;
    await waitFor(() => rows(container).length === 1, "the first row");

    await pushEvent(service, "CP-1", {
      type: "charging-session",
      session: session({ outcome: "interrupted", stopReason: "HardReset" }),
    });
    await pushEvent(service, "CP-1", {
      type: "charging-session",
      session: session({
        sessionId: "s-3",
        startedAt: "2026-10-28T12:00:00.000Z",
        outcome: "failed",
      }),
    });

    expect(rows(container).map((r) => r.dataset.outcome)).toEqual([
      "failed",
      "interrupted",
    ]);
  });

  it("says when there is no session yet", async () => {
    const service = makeService({
      listChargingSessions: vi.fn(async () => page([])),
    });
    const rendered = await renderConsole("/cp/CP-1?tab=transactions", {
      service,
    });
    root = rendered.root;
    await waitFor(
      () => rendered.container.textContent!.includes("No charging session"),
      "the empty state",
    );
  });
});
