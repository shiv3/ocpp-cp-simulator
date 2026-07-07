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

function textareaById(id: string): HTMLTextAreaElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing textarea #${id}`);
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

  it("does not offer OCPP-1.5 in local mode", async () => {
    const rendered = await renderModal({ mode: "local" });
    await openSelect("ocppVersion");

    expect(queryOptionByText("OCPP 1.5 (SOAP)")).toBeUndefined();

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

    await selectOption("ocppVersion", "OCPP 1.6J");

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

  it("maps securityProfile/authorizationKey/tls/soap fields on save and omits a blank secret on edit", async () => {
    const onSave = vi.fn();
    // Simulates the daemon's redacted edit prefill: secrets always come back
    // blank/absent, never a redaction placeholder.
    const initial = baseConfig({
      ocppVersion: "OCPP-1.5",
      securityProfile: 2,
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

    await act(async () => {
      setValue(
        inputById("soapCallbackUrl"),
        "http://cp-host:8080/ocpp/soap/CP-1",
      );
      setValue(inputById("soapPath"), "/ocpp/soap");
      setValue(
        textareaById("tlsCa"),
        "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      );
    });
    // AuthorizationKey is left blank on purpose — edit + blank must omit it.

    await act(async () => {
      saveButton().click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ChargePointConfig;
    expect(saved.ocppVersion).toBe("OCPP-1.5");
    expect(saved.soapCallbackUrl).toBe("http://cp-host:8080/ocpp/soap/CP-1");
    expect(saved.soapPath).toBe("/ocpp/soap");
    expect(saved.securityProfile).toBe(2);
    expect(saved.authorizationKey).toBeUndefined();
    expect(saved.tls?.ca).toContain("BEGIN CERTIFICATE");
    expect(saved.tls?.cert).toBeUndefined();
  });
});
