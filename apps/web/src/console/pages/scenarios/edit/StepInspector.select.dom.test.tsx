// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { updateStepData } from "../../../lib/scenarioSteps";
import { switchInLane } from "../../../test/treeFixtures";
import StepInspector from "./StepInspector";

let root: Root | null = null;
let current: ScenarioDefinition | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  root = null;
  current = null;
  document.body.replaceChildren();
});

function node(
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown> = {},
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  } as ScenarioNode;
}

/** START → route (switch, cases "a" / "b") ┬ case-0 → stepA → END
 *                                          ├ case-1 → stepB → END
 *                                          └ default → END */
function switchScenario(): ScenarioDefinition {
  return {
    id: "sw",
    name: "Switch",
    targetType: "connector",
    targetId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      node("start", ScenarioNodeType.START),
      node("route", ScenarioNodeType.SWITCH, {
        value: { $from: "state.mode" },
        cases: ["a", "b"],
      }),
      node("stepA", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("stepB", ScenarioNodeType.DELAY, { delaySeconds: 2 }),
      node("store", ScenarioNodeType.SET_STATE, { key: "mode", value: "a" }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e-start", source: "start", target: "store" },
      { id: "e-store", source: "store", target: "route" },
      { id: "e-a", source: "route", target: "stepA", sourceHandle: "case-0" },
      { id: "e-b", source: "route", target: "stepB", sourceHandle: "case-1" },
      { id: "e-d", source: "route", target: "end", sourceHandle: "default" },
      { id: "e-a-end", source: "stepA", target: "end" },
      { id: "e-b-end", source: "stepB", target: "end" },
    ],
  };
}

function choiceScenario(): ScenarioDefinition {
  return {
    ...switchScenario(),
    nodes: [
      node("start", ScenarioNodeType.START),
      node("route", ScenarioNodeType.CHOICE, {
        options: [{ weight: 1, label: "x" }, { weight: 3 }],
      }),
      node("stepA", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("stepB", ScenarioNodeType.DELAY, { delaySeconds: 2 }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e-start", source: "start", target: "route" },
      { id: "e-a", source: "route", target: "stepA", sourceHandle: "option-0" },
      { id: "e-b", source: "route", target: "stepB", sourceHandle: "option-1" },
      { id: "e-a-end", source: "stepA", target: "end" },
      { id: "e-b-end", source: "stepB", target: "end" },
    ],
  };
}

function Editor({ initial }: { initial: ScenarioDefinition }) {
  const [def, setDef] = useState(initial);
  current = def;
  const selected = def.nodes.find((n) => n.id === "route")!;
  return (
    <StepInspector
      node={selected}
      onChange={(data) => setDef(updateStepData(def, "route", data))}
      scenario={def}
      onScenarioChange={setDef}
    />
  );
}

async function render(element: React.ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

async function clickLabel(label: string): Promise<void> {
  const button = document.body.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
}

async function clickText(text: string): Promise<void> {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`no button ${text}`);
  await act(async () => button.click());
}

const lane = (handle: string) =>
  document.body.querySelector(`[data-testid="lane-${handle}"]`)?.textContent;

const handleIssues = (def: ScenarioDefinition) =>
  validateScenarioGraph(def).filter(
    (i) => i.code === "unpickableHandle" || i.code === "duplicateHandle",
  );

describe("StepInspector: switch", () => {
  it("lists the cases with their lanes and the default lane", async () => {
    await render(<Editor initial={switchScenario()} />);
    expect(lane("case-0")).toMatch(/stepA/);
    expect(lane("case-1")).toMatch(/stepB/);
    expect(lane("default")).toMatch(/End of scenario/);
    // The value reads from state; its key comes from the setState step.
    expect(
      document.body.querySelector<HTMLInputElement>(
        '[aria-label="Path of Value"]',
      )?.value,
    ).toBe("mode");
  });

  it("reorders a case and moves its lane with it", async () => {
    await render(<Editor initial={switchScenario()} />);
    await clickLabel("Move case-1 up");
    const data = current!.nodes.find((n) => n.id === "route")!.data as {
      cases: unknown[];
    };
    expect(data.cases).toEqual(["b", "a"]);
    expect(current!.edges.find((e) => e.id === "e-b")!.sourceHandle).toBe(
      "case-0",
    );
    expect(current!.edges.find((e) => e.id === "e-a")!.sourceHandle).toBe(
      "case-1",
    );
    expect(lane("case-0")).toMatch(/stepB/);
    expect(handleIssues(current!)).toEqual([]);
  });

  it("asks before removing a case that has a lane", async () => {
    await render(<Editor initial={switchScenario()} />);
    const before = current!;
    await clickLabel("Remove case-0");
    const question = document.body.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toMatch(/case-0 leads to/);
    expect(current).toBe(before);

    await clickText("Keep");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(current).toBe(before);

    await clickLabel("Remove case-0");
    await clickText("Remove with its edge");
    expect(current!.edges.map((e) => e.id)).not.toContain("e-a");
    expect(current!.edges.find((e) => e.id === "e-b")!.sourceHandle).toBe(
      "case-0",
    );
    expect(lane("case-0")).toMatch(/stepB/);
    expect(handleIssues(current!)).toEqual([]);
  });

  it("removes a case without a lane at once, and warns on a duplicate", async () => {
    await render(<Editor initial={switchScenario()} />);
    await clickText("Add case");
    expect(lane("case-2")).toMatch(/no step yet/);
    await clickLabel("Remove case-2");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(
      (
        current!.nodes.find((n) => n.id === "route")!.data as unknown as {
          cases: unknown[];
        }
      ).cases,
    ).toEqual(["a", "b"]);

    await clickText("Add case");
    await clickText("Add case");
    expect(document.body.textContent).toMatch(/Same value as case-2/);
  });
});

describe("StepInspector: choice", () => {
  it("shows each option's share and moves lanes with options", async () => {
    await render(<Editor initial={choiceScenario()} />);
    expect(
      document.body.querySelector('[data-testid="choice-share-0"]')
        ?.textContent,
    ).toBe("25%");
    expect(
      document.body.querySelector('[data-testid="choice-share-1"]')
        ?.textContent,
    ).toBe("75%");
    await clickLabel("Move option-0 down");
    expect(current!.edges.find((e) => e.id === "e-a")!.sourceHandle).toBe(
      "option-1",
    );
    expect(lane("option-1")).toMatch(/stepA/);
    expect(handleIssues(current!)).toEqual([]);
  });

  it("warns under two options after a confirmed removal", async () => {
    await render(<Editor initial={choiceScenario()} />);
    await clickLabel("Remove option-1");
    await clickText("Remove with its edge");
    expect(current!.edges.map((e) => e.id)).not.toContain("e-b");
    expect(document.body.textContent).toMatch(/Fewer than two options/);
  });
});

const routeData = () =>
  current!.nodes.find((n) => n.id === "route")!.data as unknown as {
    cases?: unknown;
    options?: unknown[];
  };

/** cases a / b, plus a leftover edge on case-2 (never picked so far). */
function switchWithDeadEdge(): ScenarioDefinition {
  const def = switchScenario();
  def.edges.push({
    id: "e-dead",
    source: "route",
    target: "stepB",
    sourceHandle: "case-2",
  });
  return def;
}

describe("StepInspector: adding over a leftover edge (L1)", () => {
  it("asks before reviving it, and Cancel adds nothing", async () => {
    await render(<Editor initial={switchWithDeadEdge()} />);
    const before = current!;
    await clickText("Add case");
    const question = document.body.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toMatch(
      /case-2 already has an edge in the file, to (Step \d+ · )?stepB:/,
    );
    expect(current).toBe(before);
    await clickText("Cancel");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(current).toBe(before);
  });

  it("keeps the edge: the new case runs it", async () => {
    await render(<Editor initial={switchWithDeadEdge()} />);
    await clickText("Add case");
    await clickText("Add, keep the edge");
    expect(routeData().cases).toEqual(["a", "b", ""]);
    expect(current!.edges.map((e) => e.id)).toContain("e-dead");
    expect(lane("case-2")).toMatch(/stepB/);
  });

  it("detaches the edge: only that edge goes", async () => {
    await render(<Editor initial={switchWithDeadEdge()} />);
    const edges = current!.edges;
    await clickText("Add case");
    await clickText("Add, detach the edge");
    expect(routeData().cases).toEqual(["a", "b", ""]);
    expect(current!.edges).toEqual(edges.filter((e) => e.id !== "e-dead"));
    expect(lane("case-2")).toMatch(/no step yet/);
  });

  const choiceWithDeadEdge = () => {
    const def = choiceScenario();
    def.edges.push({
      id: "e-dead",
      source: "route",
      target: "end",
      sourceHandle: "option-2",
    });
    return def;
  };

  it("asks the same for a choice option: detach", async () => {
    await render(<Editor initial={choiceWithDeadEdge()} />);
    await clickText("Add option");
    expect(
      document.body.querySelector('[role="alertdialog"]')?.textContent,
    ).toMatch(/option-2 already has an edge in the file, to End of scenario/);
    await clickText("Add, detach the edge");
    expect(routeData().options).toHaveLength(3);
    expect(current!.edges.map((e) => e.id)).not.toContain("e-dead");
  });

  it("asks the same for a choice option: keep", async () => {
    await render(<Editor initial={choiceWithDeadEdge()} />);
    await clickText("Add option");
    await clickText("Add, keep the edge");
    expect(routeData().options).toHaveLength(3);
    expect(current!.edges.map((e) => e.id)).toContain("e-dead");
    expect(lane("option-2")).toMatch(/End of scenario/);
  });
});

describe("StepInspector: removal names every edge (L2)", () => {
  it("counts the edges a removal takes", async () => {
    const def = switchScenario();
    def.edges.push({
      id: "e-a2",
      source: "route",
      target: "end",
      sourceHandle: "case-0",
    });
    await render(<Editor initial={def} />);
    await clickLabel("Remove case-0");
    expect(
      document.body.querySelector('[role="alertdialog"]')?.textContent,
    ).toMatch(
      /case-0 has 2 edges \(only the first, to Step \d+ · stepA, runs\)/,
    );
    await clickText("Remove with its 2 edges");
    expect(current!.edges.map((e) => e.id)).not.toContain("e-a");
    expect(current!.edges.map((e) => e.id)).not.toContain("e-a2");
  });
});

describe("StepInspector: malformed lists stay as the file has them", () => {
  it("cases that are not a list: notice, untouched, replaced on request (L5)", async () => {
    const def = switchScenario();
    (def.nodes[1]!.data as unknown as { cases: unknown }).cases = {
      a: 1,
    };
    await render(<Editor initial={def} />);
    const notice = document.body.querySelector(
      '[data-testid="switch-cases-not-array"]',
    );
    expect(notice?.textContent).toMatch(/not a list/);
    expect(notice?.textContent).toMatch(/\{"a":1\}/);
    expect(
      Array.from(document.body.querySelectorAll("button")).map((b) =>
        b.textContent?.trim(),
      ),
    ).not.toContain("Add case");

    // Another edit on the step leaves the cases as they are.
    const valueText = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Path of Value"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(valueText, "other");
      valueText.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(routeData().cases).toEqual({ a: 1 });

    await clickText("Replace with an empty list");
    expect(routeData().cases).toEqual([]);
    expect(
      document.body.querySelector('[data-testid="switch-cases-not-array"]'),
    ).toBeNull();
  });

  it("a null option: an invalid row drawn with weight 1, no crash (L6)", async () => {
    const def = choiceScenario();
    (def.nodes[1]!.data as unknown as { options: unknown[] }).options = [
      null,
      { weight: 3 },
    ];
    await render(<Editor initial={def} />);
    const row = document.body.querySelector('[data-testid="choice-option-0"]');
    expect(row?.textContent).toMatch(/option-0 is null, not an option/);
    expect(
      document.body.querySelector('[data-testid="choice-share-0"]')
        ?.textContent,
    ).toBe("25%");

    // Editing another option keeps the null entry as it is.
    const label = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Label of option-1"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(label, "y");
      label.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(routeData().options).toEqual([null, { weight: 3, label: "y" }]);

    await clickText("Replace with an empty option");
    expect(routeData().options).toEqual([{}, { weight: 3, label: "y" }]);
  });
});

describe("StepInspector: read-only", () => {
  it("renders the switch inspector disabled, with its lanes", async () => {
    const def = switchScenario();
    await render(
      <fieldset disabled>
        <StepInspector
          node={def.nodes[1]!}
          onChange={() => undefined}
          scenario={def}
        />
      </fieldset>,
    );
    expect(lane("case-1")).toMatch(/stepB/);
    expect(
      document.body.querySelector('[data-testid="switch-case-0"]'),
    ).not.toBeNull();
  });
});

describe("StepInspector: lane targets are numbered as the boxes are", () => {
  it("numbers a nested switch's lane targets in tree pre-order", async () => {
    // route 1, a 2, inner 3, x 4, y 5, b 6: a shape the one-fork layout
    // never numbered.
    const def = switchInLane();
    const inner = def.nodes.find((n) => n.id === "inner")!;
    await render(
      <StepInspector node={inner} onChange={() => {}} scenario={def} />,
    );
    expect(lane("case-0")).toMatch(/Step 4 · /);
    expect(lane("default")).toMatch(/Step 5 · /);
  });

  it("uses the numbers the editor passes", async () => {
    const def = switchInLane();
    const inner = def.nodes.find((n) => n.id === "inner")!;
    await render(
      <StepInspector
        node={inner}
        onChange={() => {}}
        scenario={def}
        stepNumbers={new Map([["x", 9]])}
      />,
    );
    expect(lane("case-0")).toMatch(/Step 9 · /);
  });
});
