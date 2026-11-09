// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type ScenarioDefinition,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  insertForkBlock,
  insertStepIntoNewLoop,
  moveStepTo,
  recognizeBlockTree,
} from "../../../lib/blockTree";
import {
  end,
  graph,
  node,
  start,
} from "../../../lib/__fixtures__/blockTreeKit";
import { useState } from "react";
import StepsView from "./StepsView";

let root: Root | null = null;
let container: HTMLElement;
const onInsertStep = vi.fn();
const onInsertStepIntoLoop = vi.fn();
const onMoveStepTo = vi.fn();
const onMoveStep = vi.fn();

const chain = () =>
  graph(
    [start(), node("a"), node("b"), end()],
    [
      ["start", "a"],
      ["a", "b"],
      ["b", "end"],
    ],
  );

async function render(def: ScenarioDefinition) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsView
        tree={recognizeBlockTree(def)}
        editable
        selectedStepId={null}
        onSelectStep={vi.fn()}
        onInsertStep={onInsertStep}
        onInsertStepIntoLoop={onInsertStepIntoLoop}
        onMoveStepTo={onMoveStepTo}
        onMoveStep={onMoveStep}
        onDeleteStep={vi.fn()}
        onAddLane={vi.fn()}
        onRemoveLane={vi.fn()}
        onUnwrapLoop={vi.fn()}
      />,
    );
  });
}

async function click(el: Element | null) {
  expect(el, "expected the element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const addStepButton = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === "+ Add step",
  ) ?? null;
const structure = (kind: string) =>
  container.querySelector<HTMLButtonElement>(
    `button[data-step-structure="${kind}"]`,
  );

function pointer(type: string, el: Element, x: number, y: number) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  });
}
const handleOf = (id: string) =>
  container.querySelector(
    `[data-step-id="${id}"] [aria-label="Drag to reorder"]`,
  )!;

/** Where the drop targets are on this fake screen: a zone is 100px wide. */
const zones: Record<string, { top: number; bottom: number }> = {};

describe("StepsView: structure entries and cross-lane drags", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const block = this.dataset.block;
        const zone =
          zones[this.dataset.dropPending ?? this.dataset.dropEmpty ?? ""];
        const top = zone
          ? zone.top
          : block !== undefined
            ? Number(block) * 58
            : 0;
        return {
          top,
          bottom: zone ? zone.bottom : top + 52,
          height: zone ? zone.bottom - zone.top : block !== undefined ? 52 : 0,
          left: 0,
          right: zone ? 100 : 0,
          width: zone ? 100 : 0,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    for (const k of Object.keys(zones)) delete zones[k];
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("Repeat at the end of a lane draws an empty block and writes nothing", async () => {
    await render(chain());
    await click(addStepButton());
    await click(structure("loop"));
    const pending = container.querySelector("[data-pending-loop]");
    expect(pending).toBeTruthy();
    expect(pending?.textContent).toContain("Repeat (empty)");
    expect(pending?.textContent).toContain("not saved");
    expect(onInsertStep).not.toHaveBeenCalled();
    expect(onInsertStepIntoLoop).not.toHaveBeenCalled();
    expect(onMoveStepTo).not.toHaveBeenCalled();
    // The × takes it away again.
    await click(
      container.querySelector('button[aria-label="Remove the empty repeat"]'),
    );
    expect(container.querySelector("[data-pending-loop]")).toBeNull();
  });

  it("the first step added to the empty block is what makes it real", async () => {
    await render(chain());
    await click(addStepButton());
    await click(structure("loop"));
    const inside = container.querySelector("[data-pending-loop]")!;
    await click(
      Array.from(inside.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "+ Add step",
      ) ?? null,
    );
    await click(
      Array.from(inside.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Delay",
      ) ?? null,
    );
    expect(onInsertStepIntoLoop).toHaveBeenCalledWith(
      "root",
      2,
      ScenarioNodeType.DELAY,
    );
    expect(onInsertStep).not.toHaveBeenCalled();
  });

  it("a step dropped into the empty block is moved into a new Repeat", async () => {
    await render(chain());
    await click(addStepButton());
    await click(structure("loop"));
    zones["root"] = { top: 200, bottom: 280 };
    pointer("pointerdown", handleOf("a"), 50, 26);
    pointer("pointermove", handleOf("a"), 50, 240);
    expect(
      container
        .querySelector("[data-pending-loop]")
        ?.className.includes("accent") ||
        container.querySelector("[data-drop-refusal]") === null,
    ).toBe(true);
    pointer("pointerup", handleOf("a"), 50, 240);
    expect(onMoveStepTo).toHaveBeenCalledWith("a", "root", 2, true);
    expect(onMoveStep).not.toHaveBeenCalled();
  });

  it("Repeat in the middle of a lane: a bounded pending block there; its picker refuses a switch, saying why", async () => {
    await render(chain());
    await click(
      container.querySelector(
        'button[aria-label="Insert step between 1 and 2"]',
      ),
    );
    const loop = structure("loop")!;
    expect(loop.getAttribute("aria-disabled")).toBeNull();
    await click(loop);
    const pending = container.querySelector("[data-pending-slot]");
    expect(pending?.getAttribute("data-pending-slot")).toBe("1");
    expect(
      container.querySelector('[data-testid="pending-loop-bounded"]'),
    ).toBeTruthy();
    // The pending block stands between steps 1 and 2.
    const order = Array.from(
      container.querySelectorAll("[data-step-id], [data-pending-slot]"),
    ).map((el) => el.getAttribute("data-step-id") ?? "pending");
    expect(order).toEqual(["a", "pending", "b"]);
    await click(
      Array.from(pending!.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "+ Add step",
      ) ?? null,
    );
    const sw = container.querySelector<HTMLButtonElement>(
      'button[data-step-type="switch"]',
    )!;
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      sw.focus();
    });
    expect(
      container.querySelector('[data-testid="step-picker-refusal"]')
        ?.textContent,
    ).toMatch(/switch or a choice/);
    await click(sw);
    expect(onInsertStepIntoLoop).not.toHaveBeenCalled();
    await click(container.querySelector('button[data-step-type="delay"]'));
    expect(onInsertStepIntoLoop).toHaveBeenLastCalledWith(
      "root",
      1,
      ScenarioNodeType.DELAY,
    );
  });

  it("Switch and Choice are structure entries, not plain steps", async () => {
    await render(chain());
    await click(addStepButton());
    expect(container.querySelector('[data-step-type="switch"]')).toBeNull();
    expect(container.querySelector('[data-step-type="choice"]')).toBeNull();
    await click(structure("switch"));
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root",
      2,
      ScenarioNodeType.SWITCH,
    );
    await click(addStepButton());
    await click(structure("choice"));
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root",
      2,
      ScenarioNodeType.CHOICE,
    );
  });

  it("empty lanes of a new branch say where to drop; a step dragged in lands in the lane", async () => {
    const def = chain();
    const forked = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "switch",
    );
    await render(forked);
    const hints = container.querySelectorAll("[data-drop-empty]");
    expect(hints).toHaveLength(2);
    expect(hints[0].textContent).toBe("Drop steps here");
    zones["root/1/lanes/0"] = { top: 300, bottom: 340 };
    pointer("pointerdown", handleOf("a"), 50, 26);
    pointer("pointermove", handleOf("a"), 50, 320);
    pointer("pointerup", handleOf("a"), 50, 320);
    expect(onMoveStepTo).toHaveBeenCalledWith("a", "root/1/lanes/0", 0, false);
  });

  it("a refused drop shows why and moves nothing", async () => {
    // t ends its branch (a step labelled End): it cannot be moved.
    const def = graph(
      [start(), node("a"), node("t", ScenarioNodeType.DELAY, { label: "End" })],
      [
        ["start", "a"],
        ["a", "t"],
      ],
    );
    const forked = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "switch",
    );
    await render(forked);
    zones["root/1/lanes/0"] = { top: 300, bottom: 340 };
    pointer("pointerdown", handleOf("t"), 50, 120);
    pointer("pointermove", handleOf("t"), 50, 320);
    expect(container.querySelector("[data-drop-refusal]")?.textContent).toMatch(
      /Cannot drop here/,
    );
    pointer("pointerup", handleOf("t"), 50, 320);
    expect(onMoveStepTo).not.toHaveBeenCalled();
    expect(container.querySelector("[data-drop-refusal]")).toBeTruthy();
  });

  describe("with the real block-tree operations behind it", () => {
    let latest: ScenarioDefinition;
    const Harness = ({ initial }: { initial: ScenarioDefinition }) => {
      const [def, setDef] = useState(initial);
      latest = def;
      const tree = recognizeBlockTree(def);
      return (
        <StepsView
          tree={tree}
          editable
          selectedStepId={null}
          onSelectStep={vi.fn()}
          onInsertStep={vi.fn()}
          onInsertStepIntoLoop={(path, index, type) =>
            setDef(insertStepIntoNewLoop(def, tree, path, index, type))
          }
          onMoveStepTo={(id, path, index, loop) =>
            setDef(moveStepTo(def, tree, id, path, index, loop))
          }
        />
      );
    };
    const renderHarness = async (def: ScenarioDefinition) => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root!.render(<Harness initial={def} />));
    };

    it("Repeat, then a drop: the file gets exactly one back edge", async () => {
      const def = chain();
      await renderHarness(def);
      await click(addStepButton());
      await click(structure("loop"));
      // Nothing is written by asking for the block.
      expect(latest).toBe(def);
      zones["root"] = { top: 200, bottom: 280 };
      pointer("pointerdown", handleOf("a"), 50, 26);
      pointer("pointermove", handleOf("a"), 50, 240);
      pointer("pointerup", handleOf("a"), 50, 240);
      expect(latest.edges.filter((e) => e.source === "a")).toHaveLength(1);
      expect(latest.edges.find((e) => e.source === "a")?.target).toBe("a");
      expect(container.querySelector("[data-loop-block]")).toBeTruthy();
      expect(container.querySelector("[data-pending-loop]")).toBeNull();
    });

    it("Repeat, then the first added step: the new step loops onto itself", async () => {
      const def = chain();
      await renderHarness(def);
      await click(addStepButton());
      await click(structure("loop"));
      const inside = container.querySelector("[data-pending-loop]")!;
      const within = (text: string) =>
        Array.from(inside.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === text,
        ) ?? null;
      await click(within("+ Add step"));
      await click(within("Delay"));
      const added = latest.nodes.find(
        (n) => !def.nodes.some((o) => o.id === n.id),
      )!;
      expect(latest.edges.filter((e) => e.source === added.id)).toEqual([
        expect.objectContaining({ target: added.id }),
      ]);
      expect(container.querySelector("[data-loop-block]")).toBeTruthy();
    });
  });
});
