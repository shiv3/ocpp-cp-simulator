// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../../test/harness";
import {
  duplicateHandleScenario,
  forkScenario,
  messyScenario,
} from "../../../test/scenarioFixtures";

async function renderEditor(
  def: ScenarioDefinition,
  view: "graph" | "steps" = "graph",
): Promise<{ container: HTMLElement; root: Root }> {
  const service = createFakeChargePointService({
    listScenarioDefinitions: vi.fn(async () => [def]),
  });
  const result = await renderConsole(
    `/scenarios/edit?cp=CP-1&connector=1&id=${def.id}&view=${view}`,
    { service },
  );
  await flush();
  return result;
}

/** The severity badge on the card (Graph) or box (Steps) of `nodeId`. */
function badge(container: HTMLElement, nodeId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-node-id="${nodeId}"] [data-issue-badge], [data-step-id="${nodeId}"] [data-issue-badge]`,
  );
}

function issueLine(container: HTMLElement, code: string): HTMLElement {
  const span = container.querySelector(
    `[data-testid="graph-issues"] [data-issue="${code}"]`,
  );
  const line = span?.closest<HTMLElement>("[data-issue-line]");
  if (!line) throw new Error(`no warning line ${code}`);
  return line;
}

const cardButton = (container: HTMLElement, nodeId: string) =>
  container.querySelector<HTMLButtonElement>(
    `[data-node-id="${nodeId}"] button[data-step-select]`,
  )!;

describe("ScenarioEditPage: diagnostics marked on the graph", () => {
  let root: Root | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      await act(async () => r.unmount());
      root = null;
    }
    document.body.innerHTML = "";
  });

  it("marks the switch, the unreachable step and the step needing a CALL, and strokes the unpickable edge", async () => {
    const r = await renderEditor(messyScenario());
    root = r.root;
    const { container } = r;

    expect(badge(container, "route")?.getAttribute("aria-label")).toBe(
      "1 warning",
    );
    expect(badge(container, "route")?.dataset.issueBadge).toBe("warning");
    expect(badge(container, "late")?.getAttribute("aria-label")).toBe(
      "1 warning",
    );
    expect(badge(container, "notify")?.dataset.issueBadge).toBe("error");
    expect(badge(container, "notify")?.getAttribute("title")).toContain(
      "needs a CSMS call",
    );
    expect(badge(container, "store")).toBeNull();
    // The card's accessible description carries the messages.
    const route = cardButton(container, "route");
    const description = document.getElementById(
      route.getAttribute("aria-describedby")!,
    );
    expect(description?.textContent).toContain("has an edge it never takes");
    expect(route.className).toContain("border-cx-amber/70");

    // The unpickable edge is the third lane's fork edge: drawn, so stroked.
    const edge = container.querySelector<SVGPathElement>(
      'path[data-edge-id="e-nohandle"]',
    );
    expect(edge?.getAttribute("data-issue")).toBe("unpickableHandle");
    expect(edge?.getAttribute("stroke")).toBe("var(--cx-amber)");
    expect(
      container.querySelectorAll('[data-edge-issue="warning"]'),
    ).toHaveLength(1);
    expect(
      container
        .querySelector('path[data-edge-id="e-case0"]')
        ?.hasAttribute("data-issue"),
    ).toBe(false);
  });

  it("marks the boxes of the Steps view, where no edge is drawn", async () => {
    const r = await renderEditor(messyScenario(), "steps");
    root = r.root;
    const { container } = r;
    expect(badge(container, "route")).not.toBeNull();
    expect(badge(container, "late")).not.toBeNull();
    expect(badge(container, "notify")?.dataset.issueBadge).toBe("error");
    expect(badge(container, "store")).toBeNull();
    expect(container.querySelector("[data-edge-issue]")).toBeNull();
  });

  it("a warning line selects its step, and pointing at one lights the other", async () => {
    const r = await renderEditor(messyScenario());
    root = r.root;
    const { container } = r;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;

    const line = issueLine(container, "noCallHeld");
    expect(line.tagName).toBe("BUTTON");
    await act(async () => line.click());
    expect(cardButton(container, "notify").getAttribute("aria-pressed")).toBe(
      "true",
    );
    // The inspector opened on it.
    expect(container.textContent).not.toContain("Select a step");
    expect(scrolled).toHaveBeenCalled();

    // Hovering a line highlights its card ...
    const unreachable = issueLine(container, "unreachable");
    await act(async () => {
      unreachable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(cardButton(container, "late").className).toContain(
      "ring-cx-amber/30",
    );
    expect(cardButton(container, "route").className).not.toContain(
      "ring-cx-amber/30",
    );
    await act(async () => {
      unreachable.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(cardButton(container, "late").className).not.toContain(
      "ring-cx-amber/30",
    );

    // ... and hovering a marked card highlights its lines.
    await act(async () => {
      cardButton(container, "route").dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true }),
      );
    });
    expect(issueLine(container, "unpickableHandle").className).toContain(
      "bg-cx-amber/15",
    );
    expect(issueLine(container, "noCallHeld").className).not.toContain(
      "bg-cx-rose/15",
    );
  });

  it("marks the forking step of extraOutgoing", async () => {
    const r = await renderEditor(forkScenario());
    root = r.root;
    expect(badge(r.container, "status")?.getAttribute("title")).toContain(
      "only the first one runs",
    );
    expect(r.container.querySelectorAll("[data-issue-badge]")).toHaveLength(1);
  });

  it("strokes a drawn duplicate-handle edge", async () => {
    const r = await renderEditor(duplicateHandleScenario());
    root = r.root;
    const edge = r.container.querySelector('path[data-edge-id="e-dup"]');
    expect(edge?.getAttribute("data-issue")).toBe("duplicateHandle");
    expect(badge(r.container, "route")).not.toBeNull();
    expect(badge(r.container, "second")).not.toBeNull();
    expect(badge(r.container, "first")).toBeNull();
  });

  it("marks nothing for a clean scenario", async () => {
    const clean = forkScenario();
    clean.edges = clean.edges.filter(
      (e) => e.target !== "wait" && e.source !== "wait",
    );
    clean.nodes = clean.nodes.filter((n) => n.id !== "wait");
    const r = await renderEditor(clean);
    root = r.root;
    expect(
      r.container.querySelector('[data-testid="graph-issues"]'),
    ).toBeNull();
    expect(r.container.querySelector("[data-issue-badge]")).toBeNull();
    expect(r.container.querySelector("[data-edge-issue]")).toBeNull();
    expect(r.container.querySelector("path[data-issue]")).toBeNull();
  });
});
