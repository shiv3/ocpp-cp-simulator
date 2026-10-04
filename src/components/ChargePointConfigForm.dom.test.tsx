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
});
