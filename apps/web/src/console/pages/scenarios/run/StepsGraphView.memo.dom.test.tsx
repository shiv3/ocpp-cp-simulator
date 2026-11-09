// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recognizeBlockTree } from "../../../lib/blockTree";
import * as layoutModule from "../../../lib/treeGraphLayout";
import { withDetached } from "../../../test/treeFixtures";
import StepsGraphView from "./StepsGraphView";

vi.mock("../../../lib/treeGraphLayout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/treeGraphLayout")>();
  return { ...actual, layoutTreeGraph: vi.fn(actual.layoutTreeGraph) };
});

let root: Root | null = null;

function pointer(type: string, el: Element, clientY: number) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientY,
      }),
    );
  });
}

describe("StepsGraphView: layout memo", () => {
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

  it("a drag's pointer moves never lay the tree out again", async () => {
    const layout = vi.mocked(layoutModule.layoutTreeGraph);
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const tree = recognizeBlockTree(withDetached());
    await act(async () => {
      root!.render(
        <StepsGraphView
          tree={tree}
          editable
          selectedStepId={null}
          onMoveStep={() => {}}
        />,
      );
    });
    const calls = layout.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const card = container.querySelector('[data-node-id="s1"]')!;
    pointer("pointerdown", card, 89);
    for (const y of [100, 120, 150, 180]) pointer("pointermove", card, y);
    expect(container.querySelector("[data-drop-indicator]")).toBeTruthy();
    expect(layout.mock.calls.length).toBe(calls);
    pointer("pointerup", card, 180);
  });
});
