// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
  type FakeChargePointService,
} from "../../test/harness";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ConfigurationKeyInfo } from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import type { ChargePointService } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";

/** #612: the CP page's "Configuration" tab reads and writes configuration keys. */

const KEYS: ConfigurationKeyInfo[] = [
  {
    key: "HeartbeatInterval",
    value: "300",
    type: "integer",
    readonly: false,
  },
  {
    key: "GetConfigurationMaxKeys",
    value: "99",
    type: "integer",
    readonly: true,
  },
];

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

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("ConfigurationKeysTab", () => {
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

  async function mount(overrides: Partial<ChargePointService>) {
    const rendered = await renderConsole("/cp/CP-1?tab=configuration", {
      service: makeService(overrides),
    });
    root = rendered.root;
    return rendered.container;
  }

  it("lists keys; only a writable key has an editor", async () => {
    const container = await mount({
      getConfigurationKeys: vi.fn(async () => ({ keys: KEYS, unknown: [] })),
      setConfigurationKey: vi.fn(),
    });
    await waitFor(
      () =>
        container.querySelectorAll('[data-testid="config-key-row"]').length ===
        2,
      "key rows",
    );
    expect(
      container.querySelectorAll("input[aria-label^='Value of']"),
    ).toHaveLength(1);
    expect(container.textContent).toContain("GetConfigurationMaxKeys");
    expect(container.textContent).toContain("Read-only");
  });

  it("saves a changed value and shows a refusal against its row", async () => {
    const setConfigurationKey = vi
      .fn()
      .mockResolvedValueOnce("Accepted")
      .mockRejectedValueOnce(new Error("invalid value for configuration key"));
    const container = await mount({
      getConfigurationKeys: vi.fn(async () => ({ keys: KEYS, unknown: [] })),
      setConfigurationKey,
    });
    await waitFor(
      () => container.querySelector("input[aria-label^='Value of']") !== null,
      "editor",
    );
    const input = () =>
      container.querySelector<HTMLInputElement>(
        "input[aria-label^='Value of']",
      )!;
    const save = () =>
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Save",
      )!;
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input(), value);
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    expect(save().disabled).toBe(true);
    await type("30");
    await act(async () => save().click());
    expect(setConfigurationKey).toHaveBeenCalledWith(
      "CP-1",
      "HeartbeatInterval",
      "30",
    );
    await waitFor(
      () => container.querySelector("[role=status]") !== null,
      "saved note",
    );

    await type("abc");
    await act(async () => save().click());
    await waitFor(
      () => container.querySelector("[role=alert]") !== null,
      "error note",
    );
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "invalid value",
    );
  });

  it("says so when the connection cannot read keys", async () => {
    const container = await mount({
      getConfigurationKeys: undefined,
      setConfigurationKey: undefined,
    });
    await waitFor(
      () => container.textContent?.includes("not available") === true,
      "unsupported note",
    );
  });
});
