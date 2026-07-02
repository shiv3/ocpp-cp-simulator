// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SimulatorConfigInput, WireSimulatorConfig } from "../../protocol";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { getConfigBasicAuthPassword } from "../configPort";
import { useConfig } from "./useConfig";

type ConfigOnlyService = Pick<
  ChargePointService,
  "loadConfig" | "saveConfig" | "subscribeConfig"
>;

let service: ConfigOnlyService;

vi.mock("../providers/DataProvider", () => ({
  useDataContext: () => ({ chargePointService: service }),
}));

function configInput(
  overrides: Partial<SimulatorConfigInput> = {},
): SimulatorConfigInput {
  return {
    wsURL: "ws://csms.test/ocpp",
    ChargePointID: "CP-1",
    connectorNumber: 1,
    tagID: "TAG-1",
    ocppVersion: "OCPP-1.6J",
    basicAuthSettings: {
      enabled: true,
      username: "user",
      password: "secret",
    },
    autoMeterValueSetting: {
      enabled: false,
      interval: 30,
      value: 10,
    },
    Experimental: {
      ChargePointIDs: [{ ChargePointID: "CP-1", ConnectorNumber: 1 }],
      TagIDs: ["TAG-1"],
    },
    BootNotification: null,
    ...overrides,
  };
}

function redactedConfig(
  overrides: Partial<WireSimulatorConfig> = {},
): WireSimulatorConfig {
  return {
    wsURL: "ws://csms.test/ocpp",
    ChargePointID: "CP-1",
    connectorNumber: 1,
    tagID: "TAG-1",
    ocppVersion: "OCPP-1.6J",
    basicAuthSettings: {
      enabled: true,
      username: "user",
    },
    autoMeterValueSetting: {
      enabled: false,
      interval: 30,
      value: 10,
    },
    Experimental: {
      ChargePointIDs: [{ ChargePointID: "CP-1", ConnectorNumber: 1 }],
      TagIDs: ["TAG-1"],
    },
    BootNotification: null,
    ...overrides,
  };
}

function Consumer(): JSX.Element {
  const { config, setConfig, isLoading } = useConfig();
  const password = getConfigBasicAuthPassword(config);

  return (
    <section>
      <div data-testid="loading">{isLoading ? "loading" : "ready"}</div>
      <div data-testid="cp-id">{config?.ChargePointID ?? "none"}</div>
      <div data-testid="tag-id">{config?.tagID ?? "none"}</div>
      <input
        aria-label="basic-auth-password"
        readOnly
        placeholder="stored on server"
        value={password}
      />
      <button
        type="button"
        onClick={() => {
          void setConfig(config ? { ...config, tagID: "TAG-SAVED" } : null);
        }}
      >
        Save
      </button>
    </section>
  );
}

async function renderConsumer(): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Consumer />);
  });
  return { container, root };
}

function text(container: HTMLElement, testId: string): string {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`Missing element ${testId}`);
  return el.textContent ?? "";
}

function passwordInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector(
    'input[aria-label="basic-auth-password"]',
  );
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Missing password input");
  }
  return input;
}

describe("useConfig ChargePointService consumer", () => {
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

  it("loads, saves, and rerenders subscribeConfig updates through the service", async () => {
    let configHandler: ((config: WireSimulatorConfig | null) => void) | null =
      null;
    const unsubscribe = vi.fn();
    service = {
      loadConfig: vi.fn().mockResolvedValue(configInput()),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      subscribeConfig: vi.fn((handler) => {
        configHandler = handler;
        return unsubscribe;
      }),
    };

    const rendered = await renderConsumer();
    roots.push(rendered.root);

    expect(service.loadConfig).toHaveBeenCalledTimes(1);
    expect(service.subscribeConfig).toHaveBeenCalledTimes(1);
    expect(text(rendered.container, "loading")).toBe("ready");
    expect(text(rendered.container, "cp-id")).toBe("CP-1");
    expect(passwordInput(rendered.container).value).toBe("secret");

    await act(async () => {
      configHandler?.(redactedConfig({ ChargePointID: "CP-2" }));
    });

    expect(text(rendered.container, "cp-id")).toBe("CP-2");
    expect(passwordInput(rendered.container).value).toBe("");

    await act(async () => {
      rendered.container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(service.saveConfig).toHaveBeenCalledTimes(1);
    expect(service.saveConfig).toHaveBeenCalledWith({
      ...redactedConfig({ ChargePointID: "CP-2" }),
      tagID: "TAG-SAVED",
    });

    act(() => {
      rendered.root.unmount();
    });
    roots = [];
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a redacted password empty and leaves the stored secret intact on save", async () => {
    let stored = configInput({
      basicAuthSettings: {
        enabled: true,
        username: "user",
        password: "server-secret",
      },
    });
    service = {
      loadConfig: vi.fn().mockResolvedValue(redactedConfig()),
      saveConfig: vi.fn(async (next) => {
        if (!next) {
          return;
        }
        stored = {
          ...next,
          basicAuthSettings: {
            ...next.basicAuthSettings,
            password:
              typeof next.basicAuthSettings.password === "string" &&
              next.basicAuthSettings.password.length > 0
                ? next.basicAuthSettings.password
                : stored.basicAuthSettings.password,
          },
        };
      }),
      subscribeConfig: vi.fn(() => () => undefined),
    };

    const rendered = await renderConsumer();
    roots.push(rendered.root);

    expect(text(rendered.container, "loading")).toBe("ready");
    expect(text(rendered.container, "cp-id")).toBe("CP-1");
    expect(passwordInput(rendered.container).value).toBe("");
    expect(passwordInput(rendered.container).placeholder).toBe(
      "stored on server",
    );

    await act(async () => {
      rendered.container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const saved = vi.mocked(service.saveConfig).mock.calls[0]?.[0];
    expect(saved?.basicAuthSettings).toEqual({
      enabled: true,
      username: "user",
    });
    expect(stored.basicAuthSettings.password).toBe("server-secret");
  });
});
