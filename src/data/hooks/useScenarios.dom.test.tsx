// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { useScenarios } from "./useScenarios";

type ScenarioOnlyService = Pick<
  ChargePointService,
  | "listScenarioDefinitions"
  | "subscribeScenarioDefinitions"
  | "saveScenarioDefinition"
  | "replaceConnectorScenarioDefinitions"
>;

let service: ScenarioOnlyService;

vi.mock("../providers/DataProvider", () => ({
  useDataContext: () => ({ chargePointService: service }),
}));

const scenario = (
  id: string,
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition =>
  ({
    id,
    name: `Scenario ${id}`,
    nodes: [],
    edges: [],
    trigger: { type: "manual" },
    targetType: "connector",
    targetId: 1,
    ...overrides,
  }) as unknown as ScenarioDefinition;

function Consumer(): JSX.Element {
  const { scenarios, isLoading, saveScenario, deleteScenario } = useScenarios(
    "CP1",
    1,
  );

  return (
    <section>
      <div data-testid="loading">{isLoading ? "loading" : "ready"}</div>
      <div data-testid="names">
        {scenarios.map((item) => item.name).join("|")}
      </div>
      <button
        type="button"
        onClick={() => {
          void saveScenario(scenario("saved"));
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          void deleteScenario();
        }}
      >
        Delete
      </button>
    </section>
  );
}

async function renderConsumer(): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Consumer />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

function text(container: HTMLElement, testId: string): string {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`Missing element ${testId}`);
  return el.textContent ?? "";
}

describe("useScenarios ChargePointService consumer", () => {
  let roots: Root[];

  beforeEach(() => {
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  it("loads, subscribes, saves, and clears scenario definitions through the service", async () => {
    let scenarioHandler: ((definitions: ScenarioDefinition[]) => void) | null =
      null;
    const unsubscribe = vi.fn();
    service = {
      listScenarioDefinitions: vi
        .fn()
        .mockResolvedValue([
          scenario("first"),
          scenario("other", { targetId: 2 }),
          scenario("cp-level", {
            targetType: "chargePoint",
            targetId: undefined,
          }),
        ]),
      subscribeScenarioDefinitions: vi.fn((_cpId, _connectorId, handler) => {
        scenarioHandler = handler;
        return unsubscribe;
      }),
      saveScenarioDefinition: vi.fn().mockResolvedValue(scenario("saved")),
      replaceConnectorScenarioDefinitions: vi.fn().mockResolvedValue([]),
    };

    const rendered = await renderConsumer();
    roots.push(rendered.root);

    expect(service.listScenarioDefinitions).toHaveBeenCalledWith("CP1", 1);
    expect(service.subscribeScenarioDefinitions).toHaveBeenCalledWith(
      "CP1",
      1,
      expect.any(Function),
    );
    expect(text(rendered.container, "loading")).toBe("ready");
    expect(text(rendered.container, "names")).toBe("Scenario first");

    await act(async () => {
      scenarioHandler?.([scenario("updated")]);
    });
    expect(text(rendered.container, "names")).toBe("Scenario updated");

    await act(async () => {
      rendered.container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      "CP1",
      1,
      scenario("saved"),
    );

    await act(async () => {
      rendered.container
        .querySelectorAll("button")[1]
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
      "CP1",
      1,
      [],
    );
    expect(text(rendered.container, "names")).toBe("");

    act(() => {
      rendered.root.unmount();
    });
    roots = [];
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
