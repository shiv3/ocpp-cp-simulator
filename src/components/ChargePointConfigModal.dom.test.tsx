// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { mockReactFlow } from "../test/setup.dom";
import ChargePointConfigModal, {
  defaultChargePointConfig,
  type ChargePointConfig,
} from "./ChargePointConfigModal";

// Radix Select relies on a couple of DOM APIs jsdom doesn't implement:
// pointer capture (checked unconditionally in the trigger's pointerdown
// handler) and scrollIntoView (called when the listbox opens to keep the
// highlighted item in view). Stub them as no-ops so opening/selecting
// doesn't throw. `mockReactFlow()` additionally installs a ResizeObserver
// polyfill that Radix's Popper positioning logic needs.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  mockReactFlow();
});

function baseConfig(
  overrides: Partial<ChargePointConfig> = {},
): ChargePointConfig {
  return {
    ...defaultChargePointConfig,
    cpId: "CP-1",
    ...overrides,
  };
}

async function renderModal(props: {
  mode?: "local" | "remote";
  isNewChargePoint?: boolean;
  initialConfig?: ChargePointConfig;
  onSave?: (config: ChargePointConfig) => void;
}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ChargePointConfigModal
        isOpen
        onClose={() => undefined}
        onSave={props.onSave ?? (() => undefined)}
        initialConfig={props.initialConfig ?? baseConfig()}
        isNewChargePoint={props.isNewChargePoint ?? true}
        mode={props.mode ?? "remote"}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(rendered: { root: Root }): Promise<void> {
  await act(async () => {
    rendered.root.unmount();
  });
  document.body.innerHTML = "";
}

function selectTrigger(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing select trigger #${id}`);
  return el;
}

async function openSelect(id: string): Promise<void> {
  await act(async () => {
    selectTrigger(id).click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function queryOptionByText(text: string): HTMLElement | undefined {
  const options = Array.from(
    document.querySelectorAll('[role="option"]'),
  ) as HTMLElement[];
  return options.find((el) => el.textContent?.trim() === text);
}

function optionByText(text: string): HTMLElement {
  const match = queryOptionByText(text);
  if (!match) {
    const found = Array.from(document.querySelectorAll('[role="option"]')).map(
      (el) => el.textContent,
    );
    throw new Error(`Missing option "${text}"; found: ${found.join(", ")}`);
  }
  return match;
}

async function selectOption(id: string, text: string): Promise<void> {
  await openSelect(id);
  await act(async () => {
    optionByText(text).click();
  });
}

function inputById(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`Missing input #${id}`);
  }
  return el;
}

function setValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("Missing value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Dialog content is portaled to document.body, not into our own render
// container, so the Save/Cancel buttons must be looked up document-wide.
function saveButton(): HTMLButtonElement {
  const buttons = Array.from(
    document.querySelectorAll("button"),
  ) as HTMLButtonElement[];
  const match = buttons.find((b) => b.textContent?.includes("Save"));
  if (!match) throw new Error("Missing Save button");
  return match;
}

describe("ChargePointConfigModal — OCPP-1.5 + Security Profile UI", () => {
  let roots: Root[];

  beforeEach(() => {
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  it("offers OCPP-1.5 in local mode", async () => {
    const rendered = await renderModal({ mode: "local" });
    await openSelect("ocppVersion");

    expect(queryOptionByText("OCPP 1.5 (SOAP)")).toBeDefined();

    await unmount(rendered);
  });

  it("offers OCPP-1.5 in remote mode", async () => {
    const rendered = await renderModal({ mode: "remote" });
    await openSelect("ocppVersion");

    expect(queryOptionByText("OCPP 1.5 (SOAP)")).toBeDefined();

    await unmount(rendered);
  });

  it("does not render a Security Profile selector in local mode", async () => {
    const rendered = await renderModal({ mode: "local" });
    roots.push(rendered.root);

    expect(document.getElementById("securityProfile")).toBeNull();
  });

  it("hides the legacy Basic Auth toggle once a security profile is selected", async () => {
    const rendered = await renderModal({ mode: "remote" });
    roots.push(rendered.root);

    expect(document.getElementById("basicAuthEnabled")).not.toBeNull();

    await selectOption("securityProfile", "1 — Basic Auth");

    expect(document.getElementById("basicAuthEnabled")).toBeNull();
  });

  it("shows AuthorizationKey + CA field for profile 2 (not cert/key)", async () => {
    const rendered = await renderModal({ mode: "remote" });
    roots.push(rendered.root);

    await selectOption("securityProfile", "2 — Basic Auth + TLS (server cert)");

    expect(document.getElementById("authorizationKey")).not.toBeNull();
    expect(document.getElementById("tlsCa")).not.toBeNull();
    expect(document.getElementById("tlsCert")).toBeNull();
    expect(document.getElementById("tlsKey")).toBeNull();
  });

  it("shows client cert + key fields for profile 3 (not AuthorizationKey)", async () => {
    const rendered = await renderModal({ mode: "remote" });
    roots.push(rendered.root);

    await selectOption("securityProfile", "3 — Mutual TLS (client cert)");

    expect(document.getElementById("tlsCert")).not.toBeNull();
    expect(document.getElementById("tlsKey")).not.toBeNull();
    expect(document.getElementById("authorizationKey")).toBeNull();
  });

  it("blocks save when OCPP-1.5 is selected without a SOAP callback URL", async () => {
    const onSave = vi.fn();
    const rendered = await renderModal({
      mode: "remote",
      onSave,
      initialConfig: baseConfig({ ocppVersion: "OCPP-1.5" }),
    });
    roots.push(rendered.root);

    await act(async () => {
      saveButton().click();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "SOAP Callback URL is required",
    );
  });

  it("clears the stale SOAP callback validation message when switching away from OCPP-1.5", async () => {
    const onSave = vi.fn();
    const rendered = await renderModal({
      mode: "remote",
      onSave,
      initialConfig: baseConfig({ ocppVersion: "OCPP-1.5" }),
    });
    roots.push(rendered.root);

    await act(async () => {
      saveButton().click();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "SOAP Callback URL is required",
    );

    await selectOption("ocppVersion", "OCPP 1.6 (JSON)");

    expect(document.body.textContent).not.toContain(
      "SOAP Callback URL is required",
    );
  });

  it("blocks save on create when profile 3 is selected without cert/key", async () => {
    const onSave = vi.fn();
    const rendered = await renderModal({
      mode: "remote",
      isNewChargePoint: true,
      onSave,
    });
    roots.push(rendered.root);

    await selectOption("securityProfile", "3 — Mutual TLS (client cert)");
    await act(async () => {
      saveButton().click();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "requires a client certificate and private key",
    );
  });

  it("maps soap fields on save and omits blank soap callback URL on non-SOAP versions", async () => {
    const onSave = vi.fn();
    const initial = baseConfig({
      ocppVersion: "OCPP-1.5",
      securityProfile: undefined,
      authorizationKey: undefined,
      tls: undefined,
    });
    const rendered = await renderModal({
      mode: "remote",
      isNewChargePoint: false,
      initialConfig: initial,
      onSave,
    });
    roots.push(rendered.root);

    // Set SOAP-specific fields for OCPP-1.5
    await act(async () => {
      setValue(
        inputById("soapCallbackUrl"),
        "http://cp-host:8080/ocpp/soap/CP-1",
      );
      setValue(inputById("soapPath"), "/ocpp/soap");
    });

    await act(async () => {
      saveButton().click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ChargePointConfig;
    expect(saved.ocppVersion).toBe("OCPP-1.5");
    expect(saved.soapCallbackUrl).toBe("http://cp-host:8080/ocpp/soap/CP-1");
    expect(saved.soapPath).toBe("/ocpp/soap");
    expect(saved.securityProfile).toBeUndefined();
    expect(saved.authorizationKey).toBeUndefined();
  });

  it("offers OCPP-1.2 in local mode", async () => {
    const rendered = await renderModal({ mode: "local" });
    await openSelect("ocppVersion");

    expect(queryOptionByText("OCPP 1.2 (SOAP)")).toBeDefined();

    await unmount(rendered);
  });

  it("offers OCPP-1.2 in remote mode", async () => {
    const rendered = await renderModal({ mode: "remote" });
    await openSelect("ocppVersion");

    expect(queryOptionByText("OCPP 1.2 (SOAP)")).toBeDefined();

    await unmount(rendered);
  });

  it("blocks save when OCPP-1.2 is selected without a SOAP callback URL", async () => {
    const onSave = vi.fn();
    const rendered = await renderModal({
      mode: "remote",
      onSave,
      initialConfig: baseConfig({ ocppVersion: "OCPP-1.2" }),
    });
    roots.push(rendered.root);

    await act(async () => {
      saveButton().click();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "SOAP Callback URL is required",
    );
  });

  it("offers OCPP-1.6S in local mode", async () => {
    const rendered = await renderModal({ mode: "local" });
    await openSelect("ocppVersion");

    expect(queryOptionByText("OCPP 1.6 (SOAP)")).toBeDefined();

    await unmount(rendered);
  });

  it("offers OCPP-1.6S in remote mode", async () => {
    const rendered = await renderModal({ mode: "remote" });
    await openSelect("ocppVersion");

    expect(queryOptionByText("OCPP 1.6 (SOAP)")).toBeDefined();

    await unmount(rendered);
  });

  it("blocks save when OCPP-1.6S is selected without a SOAP callback URL", async () => {
    const onSave = vi.fn();
    const rendered = await renderModal({
      mode: "remote",
      onSave,
      initialConfig: baseConfig({ ocppVersion: "OCPP-1.6S" }),
    });
    roots.push(rendered.root);

    await act(async () => {
      saveButton().click();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "SOAP Callback URL is required",
    );
  });

  it("clears the stale SOAP callback validation message when switching away from OCPP-1.2", async () => {
    const onSave = vi.fn();
    const rendered = await renderModal({
      mode: "remote",
      onSave,
      initialConfig: baseConfig({ ocppVersion: "OCPP-1.2" }),
    });
    roots.push(rendered.root);

    await act(async () => {
      saveButton().click();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "SOAP Callback URL is required",
    );

    await selectOption("ocppVersion", "OCPP 1.6 (JSON)");

    expect(document.body.textContent).not.toContain(
      "SOAP Callback URL is required",
    );
  });

  it("clears the stale SOAP callback validation message when switching away from OCPP-1.6S", async () => {
    const onSave = vi.fn();
    const rendered = await renderModal({
      mode: "remote",
      onSave,
      initialConfig: baseConfig({ ocppVersion: "OCPP-1.6S" }),
    });
    roots.push(rendered.root);

    await act(async () => {
      saveButton().click();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "SOAP Callback URL is required",
    );

    await selectOption("ocppVersion", "OCPP 1.6 (JSON)");

    expect(document.body.textContent).not.toContain(
      "SOAP Callback URL is required",
    );
  });

  it("converts the Central System URL scheme to match the selected transport (#164)", async () => {
    const rendered = await renderModal({
      mode: "local",
      initialConfig: baseConfig({
        ocppVersion: "OCPP-1.6J",
        wsURL: "ws://localhost:8080/steve/websocket/CentralSystemService/",
      }),
    });
    roots.push(rendered.root);

    const wsURLValue = () =>
      (document.getElementById("wsURL") as HTMLInputElement).value;

    // JSON -> SOAP: ws:// becomes http://; host/port preserved. The SteVe
    // default path is transport-specific, so the well-known /websocket/
    // boilerplate is also rewritten to the SOAP /services/ path (#178).
    await selectOption("ocppVersion", "OCPP 1.2 (SOAP)");
    expect(wsURLValue()).toBe(
      "http://localhost:8080/steve/services/CentralSystemService",
    );

    // SOAP -> JSON: http:// converts back to ws://, and the SteVe /services/
    // path is rewritten back to /websocket/.
    await selectOption("ocppVersion", "OCPP 1.6 (JSON)");
    expect(wsURLValue()).toBe(
      "ws://localhost:8080/steve/websocket/CentralSystemService/",
    );
  });
});
