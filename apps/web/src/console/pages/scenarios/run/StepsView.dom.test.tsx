// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import statusTriggeredActions from "@ocpp-cp-simulator/core/utils/scenarios/status-triggered-actions.json";
import { scenarioTemplates } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import { recognizeBlockTree } from "../../../lib/blockTree";
import { isDrawableTree, treeSteps } from "../../../lib/stepTree";
import {
  deadLanes,
  forkInLoop,
  ifElseReconverges,
  loopWithSwitch,
  startFanOutWithLoop,
  switchInLane,
  withDetached,
} from "../../../test/treeFixtures";
import StepsView, { type StepTreeViewProps } from "./StepsView";

let root: Root | null = null;
let container: HTMLElement;

async function render(
  def: ScenarioDefinition,
  props: Omit<StepTreeViewProps, "tree"> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<StepsView tree={recognizeBlockTree(def)} {...props} />);
  });
}

const stepIds = (el: Element | null) =>
  Array.from(el?.querySelectorAll("[data-step-id]") ?? []).map((b) =>
    b.getAttribute("data-step-id"),
  );

const box = (id: string) =>
  container.querySelector<HTMLElement>(`[data-step-id="${id}"]`)!;
const numberOf = (id: string) =>
  box(id).querySelector(".font-mono")?.textContent;
const list = (path: string) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-lane-list]")).find(
    (el) => el.dataset.laneList === path,
  ) ?? null;
/** The step ids directly in the list of `path` (not in nested blocks). */
const ownSteps = (path: string) =>
  Array.from(list(path)?.children ?? [])
    .filter((el) => el.hasAttribute("data-block"))
    .map(
      (el) =>
        el.getAttribute("data-step-id") ??
        el.getAttribute("data-fork") ??
        el.getAttribute("data-loop-to"),
    );
const chips = (el: ParentNode = container) =>
  Array.from(el.querySelectorAll("[data-lane-condition]")).map(
    (c) => c.textContent,
  );

const STA = statusTriggeredActions as unknown as ScenarioDefinition;

describe("StepsView (block tree)", () => {
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

  it("numbers the boxes in tree pre-order: a fork, its lanes, then what follows", async () => {
    await render(ifElseReconverges());
    expect(stepIds(container)).toEqual([
      "pre",
      "check",
      "ok",
      "ko",
      "merge",
      "after",
    ]);
    expect(
      ["pre", "check", "ok", "ko", "merge", "after"].map(numberOf),
    ).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("a switch that reconverges: header, lanes side by side, merge footer, then the steps after it", async () => {
    await render(ifElseReconverges());
    expect(ownSteps("root")).toEqual(["pre", "check", "merge", "after"]);
    const fork = container.querySelector('[data-fork="check"]')!;
    expect(fork.getAttribute("data-fork-kind")).toBe("switch");
    expect(fork.querySelector('[data-testid="fork-header"]')?.textContent).toBe(
      'Switch on "a"',
    );
    expect(chips(fork)).toEqual(['case-0 → "Accepted"', "default"]);
    expect(ownSteps("root/1/lanes/0")).toEqual(["ok"]);
    expect(ownSteps("root/1/lanes/1")).toEqual(["ko"]);
    expect(fork.querySelector('[data-merge="merge"]')?.textContent).toBe(
      "Continues at step 5",
    );
  });

  it("a switch in a lane nests its own fork inside the lane", async () => {
    await render(switchInLane());
    const outer = container.querySelector('[data-fork="route"]')!;
    expect(
      outer.querySelector('[data-testid="fork-header"]')?.textContent,
    ).toBe("Switch on $from: call.idTag");
    const lane0 = outer.querySelector('[data-lane="0"]')!;
    const inner = lane0.querySelector('[data-fork="inner"]')!;
    expect(inner).toBeTruthy();
    expect(ownSteps("root/0/lanes/0")).toEqual(["a", "inner"]);
    expect(ownSteps("root/0/lanes/0/1/lanes/0")).toEqual(["x"]);
    expect(chips(inner)).toEqual(['case-0 → "Charging"', "default"]);
    expect(ownSteps("root/0/lanes/1")).toEqual(["b"]);
    // No merge: every lane runs to its end.
    expect(container.querySelector("[data-merge]")).toBeNull();
    // Pre-order: route, a, inner, x, y, b.
    expect(["route", "a", "inner", "x", "y", "b"].map(numberOf)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("a loop containing a switch: the repeating lane inside the block, the leaving lane after it", async () => {
    await render(loopWithSwitch());
    const block = container.querySelector("[data-loop-block]")!;
    expect(block.getAttribute("data-loop-to")).toBe("head");
    expect(stepIds(block)).toEqual(["head", "pick", "again"]);
    // A switch inside: it may take a way out, so not "forever".
    expect(block.textContent).toContain("Repeat");
    expect(block.textContent).not.toContain("Repeat forever");
    expect(block.querySelector("[data-leaves-loop]")?.textContent).toContain(
      "Leaves the loop",
    );
    const exit = container.querySelector('[data-loop-exit="pick"]')!;
    expect(block.contains(exit)).toBe(false);
    expect(exit.textContent).toContain("After leaving the loop at step 3");
    expect(chips(exit)).toEqual(["default"]);
    // The loop's continuation follows in the root.
    expect(ownSteps("root")).toEqual(["first", "head", "out"]);
    expect(block.contains(box("out"))).toBe(false);
  });

  it("a fork inside a loop whose lanes all come back stays inside the block", async () => {
    await render(forkInLoop());
    const block = container.querySelector("[data-loop-block]")!;
    expect(stepIds(block)).toEqual(["loopHead", "inner", "p", "q"]);
    expect(container.querySelector("[data-loop-exit]")).toBeNull();
    // The lanes meet at the loop's header: the back arm says it.
    expect(container.querySelector("[data-merge]")).toBeNull();
    expect(block.getAttribute("aria-label")).toBe("Repeated steps 1 to 4");
  });

  it("START fan-out: a fork without a box, a loop in one lane, a choice in the other", async () => {
    await render(startFanOutWithLoop());
    const fork = container.querySelector('[data-fork="start"]')!;
    expect(fork.getAttribute("data-fork-kind")).toBe("start");
    expect(box("start")).toBeNull();
    expect(fork.querySelector('[data-testid="fork-header"]')?.textContent).toBe(
      "Start: all run",
    );
    expect(chips(fork).slice(0, 2)).toEqual(["all run", "all run"]);
    const lane0 = fork.querySelector('[data-lane="0"]')!;
    expect(stepIds(lane0.querySelector("[data-loop-block]"))).toEqual([
      "l0a",
      "l0b",
    ]);
    const odds = container.querySelector('[data-fork="odds"]')!;
    expect(chips(odds)).toEqual([
      'option-0 · 30% · "o0"',
      'option-1 · 70% · "o1"',
    ]);
  });

  it("lists steps nothing reaches in a section of their own", async () => {
    await render(withDetached());
    const section = container.querySelector('[data-testid="detached-steps"]')!;
    expect(section.textContent).toContain("Steps nothing reaches");
    expect(stepIds(section)).toEqual(["i1", "i2"]);
    expect(ownSteps("detached/0")).toEqual(["i1", "i2"]);
    expect(numberOf("i1")).toBe("3");
  });

  it("mutes lanes that never run and says why on the chip", async () => {
    await render(deadLanes());
    expect(chips()).toEqual([
      'case-0 → "a"',
      "default",
      "ignored",
      "unpickable: case-7",
    ]);
    const dead = Array.from(container.querySelectorAll("[data-dead-lane]"));
    expect(dead.map((el) => el.getAttribute("data-lane"))).toEqual(["2", "3"]);
    expect(dead[0].className).toContain("opacity-60");
    expect(dead[0].getAttribute("title")).toBe("This branch never runs");
  });

  it("a step with two edges is an 'only the first runs' fork", async () => {
    const def = withDetached();
    def.edges.push({ id: "s1->i1", source: "s1", target: "i1" });
    await render(def);
    const fork = container.querySelector('[data-fork="s1"]')!;
    expect(fork.getAttribute("data-fork-kind")).toBe("extra");
    expect(fork.querySelector('[data-testid="fork-header"]')?.textContent).toBe(
      "Only the first runs",
    );
    expect(chips(fork)).toEqual(["runs", "ignored"]);
  });

  it("a jump out of a lane is a note: back to an earlier step, or on to one", async () => {
    // b (route's default lane) jumps on into the nested lane's x: a join.
    const def = switchInLane();
    def.edges = def.edges.map((e) =>
      e.id === "b->end" ? { ...e, id: "b->x", target: "x" } : e,
    );
    await render(def);
    const note = container.querySelector('[data-link-to="x"]');
    expect(note?.textContent).toBe("Then on to step 4");
    expect(note?.getAttribute("data-link-role")).toBe("join");
    expect(list("root/0/lanes/1")!.parentElement!.contains(note)).toBe(true);
  });

  it("marks done, current and todo boxes at any depth", async () => {
    await render(switchInLane(), {
      state: "waiting",
      currentNodeId: "x",
      executedNodeIds: ["route", "a", "inner", "x"],
    });
    expect(box("route").dataset.phase).toBe("done");
    expect(box("route").querySelector('[aria-label="done"]')).toBeTruthy();
    expect(box("x").dataset.phase).toBe("current");
    expect(box("x").textContent).toContain("waiting");
    expect(box("y").dataset.phase).toBe("todo");
    // Lane tags count done/total.
    const tag = container.querySelector(
      '[data-fork="route"] [data-lane="0"] [data-testid="lane-tag"]',
    )!.textContent;
    expect(tag).toContain("2/4");
  });

  it("without a run, shows no phase and the step count per lane", async () => {
    await render(switchInLane());
    expect(box("a").dataset.phase).toBe("plain");
    expect(container.querySelector(".opacity-55")).toBeNull();
    expect(
      container.querySelector('[data-testid="lane-tag"]')?.textContent,
    ).toBe('Acase-0 → "Accepted"4');
    // Read-only: no editing controls.
    expect(
      container.querySelector('[aria-label="Drag to reorder"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("+ Add step");
    expect(container.textContent).not.toContain("+ branch");
  });

  it("a shipped loop template: the trigger above the block, the loop around the rest", async () => {
    await render(STA, {
      state: "running",
      currentNodeId: "delay-10s",
      executedNodeIds: [],
    });
    const block = container.querySelector("[data-loop-block]")!;
    expect(block.getAttribute("data-loop-to")).toBe("notification-heartbeat");
    expect(stepIds(block)).toEqual(["notification-heartbeat", "delay-10s"]);
    expect(block.contains(box("trigger-available"))).toBe(false);
    expect(block.textContent).toContain("Repeat forever");
    expect(block.textContent).toContain("Back to step 2");
    expect(block.textContent).not.toContain("waits");
    expect(block.getAttribute("aria-label")).toBe("Repeated steps 2 to 3");
    expect(container.querySelector("[data-link-to]")).toBeNull();
  });

  it("every shipped template has a START and draws every step", async () => {
    for (const template of scenarioTemplates) {
      const def = template.createScenario("CP-1", 1);
      const tree = recognizeBlockTree(def);
      expect(isDrawableTree(tree), template.id).toBe(true);
      await render(def);
      expect(stepIds(container).sort(), template.id).toEqual(
        treeSteps(tree)
          .map((s) => s.id)
          .sort(),
      );
      await act(async () => root?.unmount());
      root = null;
      document.body.innerHTML = "";
    }
  });
});
