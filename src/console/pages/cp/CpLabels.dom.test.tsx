// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
  type FakeChargePointService,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import type { Labels } from "../../../protocol/labels";
import { useCpConfigActions } from "../dashboard/useCpConfigActions";

// #471: the header relabels through `setChargePointLabels` (cp.labels.set),
// never through the Config form's `updateCp` (cp.update rebuilds the CP).
vi.mock("../dashboard/useCpConfigActions", () => ({
  useCpConfigActions: vi.fn(() => ({
    addCp: vi.fn(async () => {}),
    updateCp: vi.fn(async () => {}),
    removeCp: vi.fn(async () => true),
  })),
}));

const CONFIG = {
  wsUrl: "ws://csms.example.test/ocpp",
  connectors: 1,
  vendor: "V",
  model: "M",
  basicAuth: null,
  bootNotification: null,
};

function cpSnapshot(labels: Labels | undefined): ChargePointSnapshot {
  return {
    id: "CP-1",
    status: OCPPStatus.Available,
    error: "",
    connectors: [],
    config: { ...CONFIG, ...(labels ? { labels } : {}) },
  };
}

const button = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );

const labelInput = (name: string) =>
  document.body.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;

const chips = () =>
  Array.from(
    document.body.querySelectorAll<HTMLElement>(
      '[aria-label="Labels"] [data-label]',
    ),
  ).map((chip) => chip.textContent);

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target).toBeTruthy();
  await act(async () => target!.click());
  await flush();
}

describe("CP page labels card (#471)", () => {
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
    vi.mocked(useCpConfigActions).mockClear();
  });

  async function open(
    service: FakeChargePointService,
    mode: "local" | "remote" = "remote",
  ): Promise<void> {
    ({ root } = await renderConsole("/cp/CP-1", { service, mode }));
    await flush();
  }

  it("shows the labels as chips in the header", async () => {
    await open(
      createFakeChargePointService({
        snapshots: [cpSnapshot({ site: "s1", env: "lab" })],
      }),
    );

    expect(chips()).toEqual(["site=s1", "env=lab"]);
  });

  it("saves through setChargePointLabels, not cp.update, then closes", async () => {
    const setChargePointLabels = vi.fn(async () => {});
    const service = createFakeChargePointService({
      snapshots: [cpSnapshot({ site: "s1" })],
      setChargePointLabels,
    });
    await open(service);

    await click(button("Labels"));
    expect(labelInput("Label 1 key").value).toBe("site");
    await click(button("Add label"));
    await type(labelInput("Label 2 key"), "env");
    await type(labelInput("Label 2 value"), "lab");
    await click(button("Save labels"));

    expect(setChargePointLabels).toHaveBeenCalledWith("CP-1", {
      site: "s1",
      env: "lab",
    });
    expect(service.updateChargePoint).not.toHaveBeenCalled();
    const { updateCp } = vi.mocked(useCpConfigActions).mock.results[0].value;
    expect(updateCp).not.toHaveBeenCalled();
    expect(button("Save labels")).toBeUndefined();
    // The acknowledged map is in force: the chips (and the card's next
    // opening) show it even if the registry push never comes.
    expect(chips()).toEqual(["site=s1", "env=lab"]);
  });

  it("keeps the card and the typed rows open on a failed save", async () => {
    const setChargePointLabels = vi
      .fn<(cpId: string, labels: Labels) => Promise<void>>()
      .mockRejectedValueOnce(new Error("daemon said no"))
      .mockResolvedValueOnce(undefined);
    await open(
      createFakeChargePointService({
        snapshots: [cpSnapshot({})],
        setChargePointLabels,
      }),
    );

    await click(button("Labels"));
    await click(button("Add label"));
    await type(labelInput("Label 1 key"), "site");
    await click(button("Save labels"));

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("daemon said no");
    expect(labelInput("Label 1 key").value).toBe("site");
    expect(button("Save labels")?.disabled).toBe(false);

    await click(button("Save labels"));
    expect(setChargePointLabels).toHaveBeenCalledTimes(2);
    expect(button("Save labels")).toBeUndefined();
  });

  it("refuses invalid rows inline without calling the daemon", async () => {
    const setChargePointLabels = vi.fn(async () => {});
    await open(
      createFakeChargePointService({
        snapshots: [cpSnapshot({ site: "s1" })],
        setChargePointLabels,
      }),
    );

    await click(button("Labels"));
    await click(button("Add label"));
    await type(labelInput("Label 2 key"), "site");
    await click(button("Save labels"));

    expect(setChargePointLabels).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Label key “site” is used twice.",
    );
  });

  it("sends nothing when opened then cancelled", async () => {
    const setChargePointLabels = vi.fn(async () => {});
    await open(
      createFakeChargePointService({
        snapshots: [cpSnapshot({ site: "s1" })],
        setChargePointLabels,
      }),
    );

    await click(button("Labels"));
    await click(button("Cancel"));

    expect(setChargePointLabels).not.toHaveBeenCalled();
    expect(button("Save labels")).toBeUndefined();
  });

  it("disables the editor while the labels are unknown", async () => {
    const service = createFakeChargePointService({
      snapshots: [{ ...cpSnapshot(undefined), config: undefined }],
    });
    await open(service);

    expect(button("Labels")?.disabled).toBe(true);
  });

  it("disables the editor when the charge point cannot be read", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    await open(
      createFakeChargePointService({
        getChargePoint: vi.fn(async () => {
          throw new Error("read failed");
        }),
      }),
    );

    expect(button("Labels")?.disabled).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  // The registry's first event is its snapshot, as from the daemon. Without
  // it the page lists the CP only on the next push, and remounts its body.
  async function pushRegistry(
    service: FakeChargePointService,
    event: unknown,
  ): Promise<void> {
    await act(async () => {
      service.__handlers.subscribeRegistry.forEach((handler) => handler(event));
    });
    await flush();
  }

  it("follows a relabel pushed by the registry", async () => {
    const service = createFakeChargePointService({
      snapshots: [cpSnapshot({ site: "s1" })],
    });
    await open(service);
    await pushRegistry(service, {
      type: "snapshot",
      cps: [cpSnapshot({ site: "s1" })],
    });
    expect(chips()).toEqual(["site=s1"]);
    const reads = vi.mocked(service.getChargePoint).mock.calls.length;

    await pushRegistry(service, {
      type: "change",
      change: "updated",
      cp: cpSnapshot({ site: "s2" }),
    });

    expect(chips()).toEqual(["site=s2"]);
    // From the push itself, not from a re-read.
    expect(vi.mocked(service.getChargePoint).mock.calls.length).toBe(reads);
  });

  it("keeps what the operator is typing when a relabel is pushed", async () => {
    const service = createFakeChargePointService({
      snapshots: [cpSnapshot({ site: "s1" })],
    });
    await open(service);
    await pushRegistry(service, {
      type: "snapshot",
      cps: [cpSnapshot({ site: "s1" })],
    });
    await click(button("Labels"));
    await type(labelInput("Label 1 value"), "typed");

    await pushRegistry(service, {
      type: "change",
      change: "updated",
      cp: cpSnapshot({ site: "s2" }),
    });

    expect(chips()).toEqual(["site=s2"]);
    expect(labelInput("Label 1 value").value).toBe("typed");
  });

  it("ignores a registry push for another charge point", async () => {
    const service = createFakeChargePointService({
      snapshots: [cpSnapshot({ site: "s1" })],
    });
    await open(service);
    await pushRegistry(service, {
      type: "snapshot",
      cps: [cpSnapshot({ site: "s1" })],
    });

    await act(async () => {
      service.__handlers.subscribeRegistry.forEach((handler) =>
        handler({
          type: "change",
          change: "updated",
          cp: { ...cpSnapshot({ site: "other" }), id: "CP-2" },
        }),
      );
    });

    expect(chips()).toEqual(["site=s1"]);
  });

  it("offers no labels in Local mode", async () => {
    await open(
      createFakeChargePointService({
        snapshots: [cpSnapshot({ site: "s1" })],
      }),
      "local",
    );

    expect(button("Labels")).toBeUndefined();
    expect(chips()).toEqual([]);
  });
});
