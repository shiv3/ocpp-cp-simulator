// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultEVSettings } from "../../cp/domain/connector/EVSettings";
import { useSocMeterSync } from "./useSocMeterSync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HarnessProps {
  service: {
    getSocMeterSync: (cpId: string, connectorId: number) => Promise<boolean>;
    saveSocMeterSync: (
      cpId: string,
      connectorId: number,
      enabled: boolean,
    ) => Promise<void>;
    setConnectorSocMeterSync: (
      cpId: string,
      connectorId: number,
      enabled: boolean,
    ) => Promise<void>;
  };
}

function Harness({ service }: HarnessProps): JSX.Element {
  const { autoSyncSocMeter, handleToggleAutoSync } = useSocMeterSync({
    chargePointService: service,
    cpId: "CP-1",
    connectorId: 1,
    evSettings: defaultEVSettings,
  });

  return (
    <label>
      <input
        type="checkbox"
        checked={autoSyncSocMeter}
        onChange={handleToggleAutoSync}
      />
      Sync SoC Meter
    </label>
  );
}

async function renderHarness(service: HarnessProps["service"]): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness service={service} />);
  });
  return { container, root };
}

function checkbox(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Missing checkbox");
  }
  return input;
}

describe("useSocMeterSync", () => {
  let roots: Root[];

  beforeEach(() => {
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  it("uses service get/save and does not let async load overwrite a user toggle", async () => {
    const loaded = deferred<boolean>();
    const service = {
      getSocMeterSync: vi.fn(() => loaded.promise),
      saveSocMeterSync: vi.fn(() => Promise.resolve()),
      setConnectorSocMeterSync: vi.fn(() => Promise.resolve()),
    };

    const rendered = await renderHarness(service);
    roots.push(rendered.root);

    const toggle = checkbox(rendered.container);
    expect(service.getSocMeterSync).toHaveBeenCalledWith("CP-1", 1);
    expect(toggle.checked).toBe(true);

    await act(async () => {
      toggle.click();
    });

    expect(toggle.checked).toBe(false);
    expect(service.saveSocMeterSync).toHaveBeenCalledWith("CP-1", 1, false);

    await act(async () => {
      loaded.resolve(true);
      await loaded.promise;
    });

    expect(toggle.checked).toBe(false);
    expect(service.setConnectorSocMeterSync).toHaveBeenLastCalledWith(
      "CP-1",
      1,
      false,
    );
  });
});
