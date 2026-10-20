// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import ConnectorTabs from "./ConnectorTabs";

const CONNECTORS = [
  { id: 1, status: OCPPStatus.Available },
  { id: 2, status: OCPPStatus.Charging },
  { id: 3, status: OCPPStatus.Faulted },
];

describe("ConnectorTabs", () => {
  let root: Root | null = null;
  let container: HTMLElement;

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

  async function render(selectedId: number, onSelect = vi.fn()) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ConnectorTabs
          connectors={CONNECTORS}
          selectedId={selectedId}
          onSelect={onSelect}
        />,
      );
    });
    return onSelect;
  }

  const tabs = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

  it("renders a tablist of #n tabs; exactly the selected one is aria-selected", async () => {
    await render(2);

    expect(
      container.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
    ).toBe("Connectors");
    expect(tabs().map((t) => t.textContent?.trim())).toEqual([
      "#1",
      "#2",
      "#3",
    ]);
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("carries the status in a title and a colored dot, not in the tab's text", async () => {
    await render(1);

    const second = tabs()[1];
    expect(second.title).toBe("Connector 2 · Charging");
    expect(second.querySelector("span[aria-hidden]")?.className).toContain(
      "bg-cx-blue",
    );
  });

  it("clicking a tab selects it", async () => {
    const onSelect = await render(1);

    await act(async () => tabs()[2].click());

    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("only the selected tab is in the tab order; arrows, Home and End move the selection", async () => {
    const onSelect = await render(2);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);

    const press = async (key: string) =>
      act(async () => {
        tabs()[1].dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      });
    await press("ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith(3);
    await press("ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith(1);
    await press("Home");
    expect(onSelect).toHaveBeenLastCalledWith(1);
    await press("End");
    expect(onSelect).toHaveBeenLastCalledWith(3);
  });
});
