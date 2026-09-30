// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import WaitControls, { type WaitControlsProps } from "./WaitControls";
import { flush } from "../test/harness";

let root: Root | null = null;

function renderProps(
  canExtend: boolean,
  onControl: WaitControlsProps["onControl"] = vi.fn(async () => undefined),
): WaitControlsProps {
  return { canExtend, onControl };
}

async function render(props: WaitControlsProps): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<WaitControls {...props} />);
  });
  return container;
}

function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
}

async function click(el: HTMLElement | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.click();
  });
  await flush();
}

describe("WaitControls (#240)", () => {
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

  it("extends by 30 s, retries and continues the parked wait", async () => {
    const props = renderProps(true);
    const container = await render(props);

    await click(button(container, "+30 s"));
    await click(button(container, "Retry"));
    await click(button(container, "Continue"));

    expect(vi.mocked(props.onControl).mock.calls).toEqual([
      ["extend", 30],
      ["retry", undefined],
      ["continue", undefined],
    ]);
  });

  it("offers no extension for a wait without a timeout", async () => {
    const container = await render(renderProps(false));

    expect(button(container, "+30 s")).toBeUndefined();
    expect(button(container, "Retry")).toBeTruthy();
    expect(button(container, "Continue")).toBeTruthy();
  });

  it("shows a failed control inline instead of swallowing it", async () => {
    const container = await render(
      renderProps(
        true,
        vi.fn(async () => {
          throw new Error("Scenario s1 is not waiting");
        }),
      ),
    );

    await click(button(container, "Continue"));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Scenario s1 is not waiting",
    );
  });
});
