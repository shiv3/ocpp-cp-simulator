// @vitest-environment jsdom
import { act } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
  type FakeChargePointService,
} from "../test/harness";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
  StoredLogEntry,
} from "../../data/interfaces/ChargePointService";

function cp(id: string): ChargePointSnapshot {
  return { id, status: OCPPStatus.Available, error: "", connectors: [] };
}

function row(cpId: string, message: string): StoredLogEntry {
  return {
    timestamp: "2026-10-02T10:00:00.000Z",
    level: "INFO",
    type: "OCPP",
    cpId,
    message,
  };
}

const ROWS: Record<string, StoredLogEntry[]> = {
  "CP-1": [row("CP-1", "BootNotification"), row("CP-1", "Heartbeat")],
  "CP-2": [row("CP-2", "StatusNotification")],
};

/** What the last download handed to the browser. */
interface Download {
  name: string;
  text: string;
}

let downloads: Download[] = [];
let pendingBlobs: Blob[] = [];

async function lastDownload(): Promise<Download> {
  await flush();
  const anchorName = downloads.at(-1)?.name;
  const blob = pendingBlobs.at(-1);
  if (!anchorName || !blob) throw new Error("nothing downloaded");
  return { name: anchorName, text: await blob.text() };
}

async function render(
  path: string,
  overrides: Partial<ChargePointService> = {},
) {
  const snapshots = [cp("CP-1"), cp("CP-2")];
  const service = createFakeChargePointService({
    snapshots,
    getStateHistory: vi.fn(async () => []),
    getNetworkSimGlobal: vi.fn(async () => null),
    getNetworkSimCp: vi.fn(async () => ({
      config: null,
      resolved: {} as never,
    })),
    listStoredLogs: vi.fn(async (id: string) => ROWS[id] ?? []),
    ...overrides,
  });
  const { root } = await renderConsole(path, { service });
  await act(async () => {
    for (const handler of service.__handlers.subscribeRegistry) {
      handler({ type: "snapshot", cps: snapshots });
    }
  });
  await flush();
  return { service, root };
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

describe("downloading a charge point's logs (#421)", () => {
  let unmount: (() => void) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    downloads = [];
    pendingBlobs = [];
    // jsdom has no object URLs and does not navigate on an anchor click.
    URL.createObjectURL = vi.fn((blob: Blob) => {
      pendingBlobs.push(blob);
      return `blob:${pendingBlobs.length}`;
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ name: this.download, text: "" });
    });
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("the charge point page's message log downloads its persisted logs as JSON Lines", async () => {
    const { service, root } = await render("/cp/CP-1");
    unmount = () => act(() => root.unmount());

    await click(button("Download"));

    expect(service.listStoredLogs).toHaveBeenCalledWith("CP-1");
    const file = await lastDownload();
    expect(file.name).toMatch(/^ocpp-logs-CP-1-.+\.jsonl$/);
    expect(file.text).toBe(
      ROWS["CP-1"].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  });

  it("the charge point page's message log: Clear screen + DB deletes the persisted logs too", async () => {
    const clearStoredLogs = vi.fn(async () => {});
    const { root } = await render("/cp/CP-1", { clearStoredLogs });
    unmount = () => act(() => root.unmount());

    await click(button("Clear screen"));
    expect(clearStoredLogs).not.toHaveBeenCalled();

    await click(button("Clear screen + DB"));
    expect(clearStoredLogs).toHaveBeenCalledWith("CP-1");
  });

  /** Pushes a log line so the Charge point group lists the charge point. */
  async function logLine(service: FakeChargePointService, cpId: string) {
    await act(async () => {
      for (const handler of service.__handlers.subscribe.get(cpId) ?? []) {
        handler({
          type: "log",
          entry: {
            timestamp: new Date("2026-10-02T10:00:00.000Z"),
            level: 1,
            type: "OCPP",
            message: `line of ${cpId}`,
          },
        });
      }
    });
  }

  it("/logs downloads every charge point's logs, or the selected ones'", async () => {
    const { service, root } = await render("/logs");
    unmount = () => act(() => root.unmount());
    await logLine(service, "CP-1");
    await logLine(service, "CP-2");

    await click(button("Download"));
    let file = await lastDownload();
    expect(file.name).toMatch(/^ocpp-logs-all-.+\.jsonl$/);
    expect(
      file.text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([...ROWS["CP-1"], ...ROWS["CP-2"]]);

    const checkbox = (id: string) =>
      document.body.querySelector<HTMLInputElement>(
        `[data-filter-group="Charge point"] label[data-filter-option="${id}"] input`,
      )!;
    await click(checkbox("CP-2"));
    vi.mocked(service.listStoredLogs!).mockClear();
    await click(button("Download"));
    file = await lastDownload();
    expect(service.listStoredLogs).toHaveBeenCalledTimes(1);
    expect(service.listStoredLogs).toHaveBeenCalledWith("CP-2");
    expect(file.name).toMatch(/^ocpp-logs-CP-2-.+\.jsonl$/);

    // Two selected: both, in one file.
    await click(checkbox("CP-1"));
    vi.mocked(service.listStoredLogs!).mockClear();
    await click(button("Download"));
    file = await lastDownload();
    expect(
      vi.mocked(service.listStoredLogs!).mock.calls.map((c) => c[0]),
    ).toEqual(["CP-2", "CP-1"]);
    expect(file.name).toMatch(/^ocpp-logs-selected-.+\.jsonl$/);
  });

  it("/logs?cp= downloads that charge point's logs without touching the others", async () => {
    const { service, root } = await render("/logs?cp=CP-1");
    unmount = () => act(() => root.unmount());

    await click(button("Download"));
    const file = await lastDownload();

    expect(service.listStoredLogs).toHaveBeenCalledTimes(1);
    expect(service.listStoredLogs).toHaveBeenCalledWith("CP-1");
    expect(file.name).toMatch(/^ocpp-logs-CP-1-.+\.jsonl$/);
  });

  it("says why the logs could not be downloaded", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await render("/cp/CP-1", {
      listStoredLogs: vi.fn(async () => {
        throw new Error("database closed");
      }),
    });
    unmount = () => act(() => root.unmount());

    await click(button("Download"));

    expect(alert).toHaveBeenCalledWith(
      "Failed to download logs: database closed",
    );
    expect(downloads).toEqual([]);
  });
});
