// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeDefaultBehaviors } from "@ocpp-cp-simulator/core/cp/application/engine/behaviors/index";

import UseBehaviorForm from "../UseBehaviorForm";
import type { NodeFormData } from "../types";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const current = root;
  if (current) await act(async () => current.unmount());
  root = null;
  document.body.replaceChildren();
});

async function render(
  value: NodeFormData,
  onChange: (next: NodeFormData) => void = () => undefined,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<UseBehaviorForm value={value} onChange={onChange} />),
  );
  return container;
}

async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("UseBehaviorForm params (#654)", () => {
  it("renders one field per property of the behavior's schema, filled with the defaults", async () => {
    const c = await render({ behaviorId: "default.firmware" });
    const form = c.querySelector('[data-testid="behavior-params-form"]')!;
    expect(form).not.toBeNull();
    const selects = [...form.querySelectorAll("select")];
    expect(selects.map((s) => s.value)).toEqual([
      "none",
      "retrieveDate",
      "none",
    ]);
    expect(
      form.querySelector<HTMLInputElement>('input[type="number"]')!.value,
    ).toBe("2000");
    // The labels come from the translation table, not the schema's English.
    expect(form.textContent).toContain("Step between statuses (ms)");
  });

  it("renders a form for every built-in that declares params", () => {
    const withParams = describeDefaultBehaviors().filter((b) => b.params);
    expect(withParams.map((b) => b.id).sort()).toEqual([
      "default.firmware",
      "default.logs",
      "default.reset",
      "default.signedFirmware",
      "default.unlock",
    ]);
  });

  it("saves only what differs from the defaults", async () => {
    const seen: NodeFormData[] = [];
    const c = await render({ behaviorId: "default.firmware" }, (v) =>
      seen.push(v),
    );
    const failAt = c.querySelectorAll<HTMLSelectElement>("select")[1]!;
    await pick(failAt, "DownloadFailed");
    expect(seen.at(-1)?.params).toEqual({ failAt: "DownloadFailed" });
    // Back to the default drops the key (and the object).
    const again = await render(
      { behaviorId: "default.firmware", params: { failAt: "DownloadFailed" } },
      (v) => seen.push(v),
    );
    await pick(again.querySelectorAll<HTMLSelectElement>("select")[1]!, "none");
    expect(seen.at(-1)?.params).toBeUndefined();
  });

  it("falls back to a JSON field for a behavior it has no schema for", async () => {
    const c = await render({ behaviorId: "my-behavior", params: { a: 1 } });
    expect(c.querySelector('[data-testid="behavior-params-form"]')).toBeNull();
    expect(c.querySelector("textarea")!.value).toContain('"a": 1');
  });

  it("disable hides the params and drops them", async () => {
    const seen: NodeFormData[] = [];
    const c = await render(
      { behaviorId: "default.firmware", params: { stepMs: 5 } },
      (v) => seen.push(v),
    );
    await pick(c.querySelectorAll<HTMLSelectElement>("select")[0]!, "disable");
    expect(seen.at(-1)).toMatchObject({ mode: "disable" });
    expect(seen.at(-1)?.params).toBeUndefined();
  });
});
