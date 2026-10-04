// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";

function cpSnapshot(
  overrides: Partial<ChargePointSnapshot> = {},
): ChargePointSnapshot {
  return {
    id: "CP-1",
    status: OCPPStatus.Available,
    error: "",
    connectors: [],
    heartbeat: { intervalSeconds: 300, lastSentAt: null },
    ...overrides,
  };
}

async function renderCpPage(
  snapshot: ChargePointSnapshot,
  overrides: Partial<ChargePointService> = {},
) {
  const service = createFakeChargePointService({
    snapshots: [snapshot],
    getStateHistory: vi.fn(async () => []),
    getNetworkSimGlobal: vi.fn(async () => null),
    getNetworkSimCp: vi.fn(async () => ({
      config: null,
      resolved: {} as never,
    })),
    ...overrides,
  });
  const { root } = await renderConsole("/cp/CP-1", { service });
  await flush();
  return { root };
}

function panel(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(
    '[data-testid="charge-point-controls"]',
  );
  if (!found) throw new Error("no charge point controls");
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    panel().querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function heartbeatFigure(): HTMLElement {
  const found = panel().querySelector<HTMLElement>("dl");
  if (!found) throw new Error("no heartbeat figure");
  return found;
}

function controlsToggle(): HTMLButtonElement {
  const found = Array.from(
    panel().querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => /^Controls$/.test(b.textContent?.trim() ?? ""));
  if (!found) throw new Error("no Controls toggle");
  return found;
}

function select(label: string): HTMLSelectElement {
  const found = panel().querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`no select ${label}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function openControls(): Promise<void> {
  if (controlsToggle().getAttribute("aria-expanded") !== "true") {
    await click(controlsToggle());
  }
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("CpDetailPage: connector 0 status, Heartbeat and Authorize (#420)", () => {
  let unmount: (() => void) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem(
      "ocpp-cp.remote.tagIds",
      JSON.stringify(["TAG-A", "TAG-B"]),
    );
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows the heartbeat interval and sends a Heartbeat on demand", async () => {
    const sendHeartbeat = vi.fn(async () => {});
    const { root } = await renderCpPage(cpSnapshot(), { sendHeartbeat });
    unmount = () => act(() => root.unmount());

    expect(heartbeatFigure().textContent).toContain("300 s");
    expect(heartbeatFigure().textContent).toContain("not sent yet");

    await click(button("Send Heartbeat"));
    expect(sendHeartbeat).toHaveBeenCalledWith("CP-1");
  });

  it("keeps the last-sent time current without any new event", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "Date"],
      now: new Date("2026-10-02T10:00:00.000Z"),
    });
    try {
      const { root } = await renderCpPage(
        cpSnapshot({
          status: OCPPStatus.Unavailable,
          heartbeat: {
            intervalSeconds: 300,
            lastSentAt: "2026-10-02T09:59:50.000Z",
          },
        }),
      );
      unmount = () => act(() => root.unmount());
      expect(heartbeatFigure().textContent).toContain("last sent 10s ago");

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(heartbeatFigure().textContent).toContain("last sent 1m ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("authorizes the chosen TagID", async () => {
    const authorize = vi.fn(async () => {});
    const { root } = await renderCpPage(cpSnapshot(), { authorize });
    unmount = () => act(() => root.unmount());

    await openControls();
    await choose(select("TagID to authorize"), "TAG-B");
    await click(button("Authorize"));

    expect(authorize).toHaveBeenCalledWith("CP-1", "TAG-B");
  });

  it("sends a StatusNotification for connector 0, with the error code when Faulted", async () => {
    const sendStatusNotification = vi.fn(async () => {});
    const { root } = await renderCpPage(cpSnapshot(), {
      sendStatusNotification,
    });
    unmount = () => act(() => root.unmount());

    await openControls();
    await choose(select("Charge point status"), OCPPStatus.Unavailable);
    await click(button("Send status"));
    expect(sendStatusNotification).toHaveBeenLastCalledWith(
      "CP-1",
      0,
      OCPPStatus.Unavailable,
    );

    expect(select("Error code").disabled).toBe(true);
    await choose(select("Charge point status"), OCPPStatus.Faulted);
    expect(select("Error code").disabled).toBe(false);
    await choose(select("Error code"), "GroundFailure");
    await click(button("Send status"));
    expect(sendStatusNotification).toHaveBeenLastCalledWith(
      "CP-1",
      0,
      OCPPStatus.Faulted,
      { errorCode: "GroundFailure" },
    );
  });

  it("disables the controls while the charge point is disconnected", async () => {
    const { root } = await renderCpPage(
      cpSnapshot({ status: OCPPStatus.Unavailable }),
    );
    unmount = () => act(() => root.unmount());

    await openControls();
    expect(button("Send Heartbeat").disabled).toBe(true);
    expect(button("Authorize").disabled).toBe(true);
    expect(button("Send status").disabled).toBe(true);
  });

  it("says why a call failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await renderCpPage(cpSnapshot(), {
      sendHeartbeat: vi.fn(async () => {
        throw new Error("socket closed");
      }),
    });
    unmount = () => act(() => root.unmount());

    await click(button("Send Heartbeat"));

    expect(panel().querySelector('[role="alert"]')?.textContent).toBe(
      "Heartbeat failed: socket closed",
    );
  });

  it("folds the Heartbeat, Authorize and Status and faults groups behind a Controls toggle", async () => {
    const { root } = await renderCpPage(cpSnapshot());
    unmount = () => act(() => root.unmount());

    const toggle = controlsToggle();
    const block = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(block?.hidden).toBe(true);

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(block?.hidden).toBe(false);
    expect(
      Array.from(block?.querySelectorAll('[role="group"]') ?? []).map((g) =>
        g.getAttribute("aria-label"),
      ),
    ).toEqual(["Heartbeat", "Authorize", "Status and faults"]);
  });

  describe("heartbeat figure", () => {
    const sentAt = new Date("2026-10-02T10:00:00.000Z");
    const lastSentAt = new Date(sentAt.getTime() - 26_000).toISOString();

    async function renderAt(status: OCPPStatus) {
      vi.useFakeTimers({
        toFake: ["setInterval", "clearInterval", "Date"],
        now: sentAt,
      });
      const { root } = await renderCpPage(
        cpSnapshot({
          status,
          heartbeat: { intervalSeconds: 30, lastSentAt },
        }),
      );
      unmount = () => {
        act(() => root.unmount());
        vi.useRealTimers();
      };
    }

    it("counts down to the next heartbeat while connected", async () => {
      await renderAt(OCPPStatus.Available);
      const figure = heartbeatFigure();
      expect(figure.textContent).toContain("Heartbeat");
      expect(figure.textContent).toContain("30 s");
      expect(figure.textContent).toContain("next in 4s");
    });

    it("fills the bar from the last heartbeat to the next", async () => {
      await renderAt(OCPPStatus.Available);
      const bar =
        heartbeatFigure().querySelector<HTMLElement>("dd > div > div");
      expect(bar?.style.width).toBe("86.7%");
      expect(bar?.className).toContain("bg-cx-accent");
    });

    it("says when the last one went out while disconnected", async () => {
      await renderAt(OCPPStatus.Unavailable);
      const figure = heartbeatFigure();
      expect(figure.textContent).toContain("last sent 26s ago");
      expect(figure.textContent).not.toContain("next in");
      expect(
        figure.querySelector<HTMLElement>("dd > div > div")?.className,
      ).toContain("bg-cx-fg2");
    });

    it("has no bar and says so when no interval is configured", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { root } = await renderCpPage(
        cpSnapshot({ heartbeat: { intervalSeconds: 0, lastSentAt: null } }),
      );
      unmount = () => act(() => root.unmount());
      expect(heartbeatFigure().textContent).toContain("—");
      expect(heartbeatFigure().textContent).toContain("not configured");
      expect(heartbeatFigure().querySelector("dd > div > div")).toBe(null);
    });
  });

  it("shows a failed header Send Heartbeat while the controls are collapsed, and in its group once open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await renderCpPage(cpSnapshot(), {
      sendHeartbeat: vi.fn(async () => {
        throw new Error("socket closed");
      }),
    });
    unmount = () => act(() => root.unmount());

    await click(button("Send Heartbeat"));
    const alerts = panel().querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toBe("Heartbeat failed: socket closed");
    expect(alerts[0].closest('[role="group"]')).toBeNull();

    await openControls();
    const grouped = panel().querySelectorAll('[role="alert"]');
    expect(grouped).toHaveLength(1);
    expect(
      grouped[0].closest('[role="group"]')?.getAttribute("aria-label"),
    ).toBe("Heartbeat");
  });
});
