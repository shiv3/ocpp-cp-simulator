// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { recognizeBlockTree } from "../../../lib/blockTree";
import { LANE_W, layoutTreeGraph } from "../../../lib/treeGraphLayout";
import { ZOOM_KEY } from "../../../lib/graphZoom";
import { getTemplateById } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import StepsGraphView from "./StepsGraphView";

const wide: ScenarioDefinition = getTemplateById(
  "dataflow-authorize-branch-16",
)!.createScenario("wide", null);

let root: Root | null = null;

describe("StepsGraphView: a graph wider than its column", () => {
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

  it("opens scrolled to the trunk so it is not cut off", async () => {
    const tree = recognizeBlockTree(wide);
    const geometry = layoutTreeGraph(tree, {
      editable: false,
      phaseOf: () => "plain",
    });
    // jsdom has no layout: a 500px column, the graph's own width inside it.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => geometry.width,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<StepsGraphView tree={tree} />);
    });
    const scroller = container.querySelector<HTMLElement>(
      "[data-testid=graph-scroll]",
    )!;
    const trunk = geometry.cards[0].x;
    expect(scroller.scrollLeft).toBe(trunk - 250);
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  });
});

describe("StepsGraphView: zoom", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  const mount = async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<StepsGraphView tree={recognizeBlockTree(wide)} />);
    });
    return container;
  };
  const press = async (el: Element | null) =>
    act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const level = (c: HTMLElement) =>
    c.querySelector("[data-testid=graph-zoom-level]")!.textContent;

  it("zooms with the buttons, resets to 100% and remembers it", async () => {
    const c = await mount();
    expect(level(c)).toBe("100%");
    await press(c.querySelector("button[aria-label='Zoom out']"));
    expect(level(c)).toBe("80%");
    expect(window.localStorage.getItem(ZOOM_KEY)).toBe("0.8");
    const canvas = c.querySelector<HTMLElement>("[data-testid=graph-scroll]")!;
    expect(canvas.firstElementChild!.getAttribute("style")).toContain(
      "width: 845px",
    );
    await press(c.querySelector("button[aria-label='Zoom in']"));
    await press(c.querySelector("button[aria-label='Zoom in']"));
    expect(level(c)).toBe("125%");
    const reset = Array.from(c.querySelectorAll("button")).find(
      (b) => b.textContent === "100%",
    );
    await press(reset!);
    expect(level(c)).toBe("100%");
  });

  it("starts from the remembered zoom, and survives blocked storage", async () => {
    window.localStorage.setItem(ZOOM_KEY, "0.5");
    const c = await mount();
    expect(level(c)).toBe("50%");
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const c2 = await mount();
    await press(c2.querySelector("button[aria-label='Zoom in']"));
    expect(level(c2)).toBe("63%");
    spy.mockRestore();
  });

  it("Ctrl + wheel zooms; a plain wheel does not", async () => {
    const c = await mount();
    const canvas = c.querySelector("[data-testid=graph-scroll]")!;
    await act(async () => {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(level(c)).toBe("100%");
    const ev = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      canvas.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(level(c)).toBe("80%");
  });

  it("lays the trunk in the middle of the lanes, no wider than they are", () => {
    const g = layoutTreeGraph(recognizeBlockTree(wide), {
      editable: false,
      phaseOf: () => "plain",
    });
    const trunk = g.cards[0].x;
    expect(trunk).toBeGreaterThan(g.width * 0.3);
    expect(trunk).toBeLessThan(g.width * 0.7);
    const xs = g.cards.map((card) => card.x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(LANE_W / 2 + 1);
    expect(g.width).toBeLessThanOrEqual(Math.max(...xs) + LANE_W / 2 + 16);
  });
});
