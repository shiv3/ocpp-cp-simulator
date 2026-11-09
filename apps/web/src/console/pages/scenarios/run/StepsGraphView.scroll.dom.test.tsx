// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { recognizeBlockTree } from "../../../lib/blockTree";
import { layoutTreeGraph } from "../../../lib/treeGraphLayout";
import wide from "../../../lib/__fixtures__/dataflowAuthorizeBranch16.json";
import StepsGraphView from "./StepsGraphView";

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
    const tree = recognizeBlockTree(wide as unknown as ScenarioDefinition);
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
    const scroller = container.firstElementChild as HTMLElement;
    const trunk = geometry.cards[0].x;
    expect(scroller.scrollLeft).toBe(trunk - 250);
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  });
});
