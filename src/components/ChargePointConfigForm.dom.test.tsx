// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { mockReactFlow } from "../test/setup.dom";
import ChargePointConfigForm from "./ChargePointConfigForm";
import { defaultChargePointConfig } from "./chargePointConfig";

describe("ChargePointConfigForm", () => {
  let root: Root | null = null;

  beforeAll(() => {
    // Radix Select (the version picker) needs the pointer-capture and
    // ResizeObserver stubs the modal test installs too.
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = function () {};
    }
    mockReactFlow();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  async function render(
    props: Partial<React.ComponentProps<typeof ChargePointConfigForm>> = {},
  ) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onSave = vi.fn();
    const onCancel = vi.fn();
    await act(async () => {
      root!.render(
        <ChargePointConfigForm
          initialConfig={{ ...defaultChargePointConfig, cpId: "CP-1" }}
          mode="remote"
          onSave={onSave}
          onCancel={onCancel}
          {...props}
        />,
      );
    });
    return { container, onSave, onCancel };
  }

  const button = (label: string) =>
    Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label,
    );

  it("is a plain form, not a dialog; Save hands the config over and leaves closing to the caller", async () => {
    const { onSave, onCancel } = await render();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => button("Save")!.click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ cpId: "CP-1" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel calls onCancel without saving; submitLabel renames Save", async () => {
    const { onSave, onCancel } = await render({ submitLabel: "Add" });

    expect(button("Save")).toBeUndefined();
    await act(async () => button("Cancel")!.click());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the charge point id read-only when editing and editable when adding", async () => {
    await render({ isNewChargePoint: false });
    expect((document.getElementById("cpId") as HTMLInputElement).disabled).toBe(
      true,
    );

    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await render({ isNewChargePoint: true });
    expect((document.getElementById("cpId") as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  // Radix Select helpers: the listbox is portaled to document.body.
  async function openSelect(id: string) {
    await act(async () => document.getElementById(id)!.click());
    await act(async () => {
      await Promise.resolve();
    });
  }
  const options = () =>
    Array.from(document.querySelectorAll('[role="option"]')).map((o) =>
      o.textContent?.trim(),
    );
  async function pick(id: string, label: string) {
    await openSelect(id);
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === label);
    if (!option) throw new Error(`no option "${label}": ${options()}`);
    await act(async () => option.click());
  }
  const shown = (id: string) =>
    document.getElementById(id)?.textContent?.trim();

  describe("protocol, then version", () => {
    it("shows the protocol and the bare version, derived from the stored version", async () => {
      await render({ isNewChargePoint: true });
      expect(shown("ocppProtocol")).toBe("JSON");
      expect(shown("ocppVersion")).toBe("OCPP 1.6");

      await act(async () => root?.unmount());
      document.body.innerHTML = "";
      await render({
        initialConfig: {
          ...defaultChargePointConfig,
          cpId: "CP-1",
          ocppVersion: "OCPP-1.5",
        },
      });
      expect(shown("ocppProtocol")).toBe("SOAP");
      expect(shown("ocppVersion")).toBe("OCPP 1.5");
    });

    it("lists JSON and SOAP in the Protocol select", async () => {
      await render();
      await openSelect("ocppProtocol");
      expect(options()).toEqual(["JSON", "SOAP"]);
    });

    it("lists only the versions of the chosen protocol", async () => {
      await render();
      await openSelect("ocppVersion");
      expect(options()).toEqual(["OCPP 1.6", "OCPP 2.0.1", "OCPP 2.1"]);

      await act(async () => root?.unmount());
      document.body.innerHTML = "";
      await render({
        initialConfig: {
          ...defaultChargePointConfig,
          cpId: "CP-1",
          ocppVersion: "OCPP-1.6S",
        },
      });
      await openSelect("ocppVersion");
      expect(options()).toEqual(["OCPP 1.2", "OCPP 1.5", "OCPP 1.6"]);
    });

    it("puts Protocol and Version side by side in the same grid", async () => {
      await render();
      const protocol = document.getElementById("ocppProtocol")!;
      const version = document.getElementById("ocppVersion")!;
      expect(protocol.closest(".grid")).toBe(version.closest(".grid"));
    });

    it("switching JSON to SOAP on 1.6 saves OCPP-1.6S and flips the URL scheme", async () => {
      // Local mode: the SOAP callback URL is optional there.
      const { onSave } = await render({ mode: "local" });
      expect(
        (document.getElementById("wsURL") as HTMLInputElement).value,
      ).toMatch(/^ws:/);

      await pick("ocppProtocol", "SOAP");
      expect(shown("ocppProtocol")).toBe("SOAP");
      expect(shown("ocppVersion")).toBe("OCPP 1.6");
      expect(
        (document.getElementById("wsURL") as HTMLInputElement).value,
      ).toMatch(/^http:/);

      await act(async () => button("Save")!.click());
      expect(onSave.mock.calls[0][0]).toMatchObject({
        ocppVersion: "OCPP-1.6S",
      });
    });

    it("switching to a protocol without the current number picks its first version", async () => {
      const { onSave } = await render({
        initialConfig: {
          ...defaultChargePointConfig,
          cpId: "CP-1",
          ocppVersion: "OCPP-2.1",
        },
      });
      await pick("ocppProtocol", "SOAP");
      expect(shown("ocppVersion")).toBe("OCPP 1.2");
      await pick("ocppProtocol", "JSON");
      expect(shown("ocppVersion")).toBe("OCPP 1.6");

      await act(async () => button("Save")!.click());
      expect(onSave.mock.calls[0][0]).toMatchObject({
        ocppVersion: "OCPP-1.6J",
      });
    });

    it("picking a version keeps the protocol", async () => {
      const { onSave } = await render();
      await pick("ocppVersion", "OCPP 2.1");
      expect(shown("ocppProtocol")).toBe("JSON");
      await act(async () => button("Save")!.click());
      expect(onSave.mock.calls[0][0]).toMatchObject({
        ocppVersion: "OCPP-2.1",
      });
    });
  });

  describe("Effective WebSocket URL", () => {
    const writeText = vi.fn(async (_text: string) => {});
    const effective = () =>
      document.getElementById("effectiveWsURL") as HTMLInputElement;

    afterEach(() => {
      vi.useRealTimers();
      writeText.mockClear();
      Reflect.deleteProperty(navigator, "clipboard");
    });

    function mockClipboard() {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
    }

    it("is a read-only display of the composed URL; the old editable field is gone", async () => {
      await render({
        initialConfig: {
          ...defaultChargePointConfig,
          cpId: "CP-1",
          wsURL: "ws://csms.example:8080/ocpp/",
          basicAuthEnabled: true,
          basicAuthUsername: "user",
          basicAuthPassword: "pw",
        },
      });
      expect(document.getElementById("fullWsURL")).toBeNull();
      expect(document.body.textContent).not.toContain("Full WebSocket URL");
      expect(document.body.textContent).toContain("Effective WebSocket URL");
      expect(effective().readOnly).toBe(true);
      expect(effective().value).toBe("ws://user:pw@csms.example:8080/ocpp/");
      expect(document.body.textContent).toContain(
        "WebSocket URL + Basic Auth below, as the charge point will dial it.",
      );
    });

    it("follows the WebSocket URL field", async () => {
      await render();
      const input = document.getElementById("wsURL") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setter.call(input, "wss://other.example/ocpp/");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(effective().value).toBe("wss://other.example/ocpp/");
    });

    it("is not shown for SOAP versions", async () => {
      await render({
        initialConfig: {
          ...defaultChargePointConfig,
          cpId: "CP-1",
          ocppVersion: "OCPP-1.6S",
        },
      });
      expect(effective()).toBeNull();
    });

    it("Copy writes the URL to the clipboard and says Copied for 1.5 s", async () => {
      mockClipboard();
      await render();
      vi.useFakeTimers();
      await act(async () => button("Copy")!.click());
      expect(writeText).toHaveBeenCalledWith(effective().value);
      expect(button("Copied")).toBeDefined();

      await act(async () => {
        vi.advanceTimersByTime(1499);
      });
      expect(button("Copied")).toBeDefined();
      await act(async () => {
        vi.advanceTimersByTime(2);
      });
      expect(button("Copy")).toBeDefined();
      expect(button("Copied")).toBeUndefined();
    });

    it("Copy is a no-op when the clipboard API is missing", async () => {
      await render();
      expect(navigator.clipboard).toBeUndefined();
      await act(async () => button("Copy")!.click());
      expect(button("Copy")).toBeDefined();
      expect(button("Copied")).toBeUndefined();
    });
  });

  describe("sections", () => {
    const titles = () =>
      Array.from(document.querySelectorAll("h3")).map((h) =>
        h.textContent?.trim(),
      );

    it("puts Model specification first, then Connection", async () => {
      await render();
      expect(titles().slice(0, 2)).toEqual([
        "Model specification",
        "Connection",
      ]);
      expect(titles()).not.toContain("Basic settings");
      expect(titles()).not.toContain("Boot notification");
    });

    it("keeps Number of Connectors with Vendor, Model and Firmware Version", async () => {
      await render();
      const section = (id: string) =>
        document.getElementById(id)!.closest("section")!;
      const model = section("chargePointVendor");
      expect(model.querySelector("h3")?.textContent).toBe(
        "Model specification",
      );
      for (const id of [
        "chargePointModel",
        "firmwareVersion",
        "connectorNumber",
      ]) {
        expect(section(id)).toBe(model);
      }
      const connection = section("cpId");
      expect(connection.querySelector("h3")?.textContent).toBe("Connection");
      for (const id of [
        "ocppProtocol",
        "ocppVersion",
        "wsURL",
        "effectiveWsURL",
      ]) {
        expect(section(id)).toBe(connection);
      }
      expect(
        connection.contains(document.getElementById("connectorNumber")),
      ).toBe(false);
    });
  });
});
