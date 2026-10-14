// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createEmptyScenario, insertStep } from "../../../lib/scenarioSteps";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../../../../cp/application/scenario/ScenarioTypes";
import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../../test/harness";

function fixture(overrides: Partial<ScenarioDefinition> = {}) {
  let def = createEmptyScenario("Demo", "connector", 1);
  def = insertStep(def, 0, ScenarioNodeType.DELAY);
  return { ...def, id: "s1", description: "First draft", ...overrides };
}

async function renderEditor(def: ScenarioDefinition) {
  const saveScenarioDefinition = vi.fn(
    async (_cp: string, _c: number | null, saved: ScenarioDefinition) => saved,
  );
  const service = createFakeChargePointService({
    listScenarioDefinitions: vi.fn(async () => [def]),
    saveScenarioDefinition,
  });
  const { root } = await renderConsole(
    "/scenarios/edit?cp=CP-1&connector=1&id=s1",
    { service },
  );
  await flush();
  return { root, saveScenarioDefinition };
}

function control<T extends HTMLElement>(label: string): T {
  const found = document.body.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no control ${label}`);
  return found;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim().includes(label),
  );
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => {
    button.click();
  });
  await flush();
}

function lastSaved(
  save: ReturnType<typeof vi.fn>,
): ScenarioDefinition | undefined {
  return save.mock.calls.at(-1)?.[2] as ScenarioDefinition | undefined;
}

describe("ScenarioEditPage: description and EV settings (#424)", () => {
  let unmount: (() => void) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = "";
  });

  it("edits the description and saves it", async () => {
    const { root, saveScenarioDefinition } = await renderEditor(fixture());
    unmount = () => act(() => root.unmount());

    const description = control<HTMLInputElement>("Scenario description");
    expect(description.value).toBe("First draft");

    await type(description, "Plug, charge 10 min, unplug");
    await clickButton("Save");

    expect(lastSaved(saveScenarioDefinition)?.description).toBe(
      "Plug, charge 10 min, unplug",
    );
  });

  it("a description typed then erased leaves the scenario unchanged", async () => {
    const { root } = await renderEditor(fixture({ description: undefined }));
    unmount = () => act(() => root.unmount());

    const description = control<HTMLInputElement>("Scenario description");
    await type(description, "x");
    expect(
      document.body.querySelector('[aria-label="Unsaved changes"]'),
    ).not.toBeNull();

    await type(description, "");
    expect(
      document.body.querySelector('[aria-label="Unsaved changes"]'),
    ).toBeNull();
  });

  it("shows the scenario's EV settings, and saves only the fields that are set", async () => {
    const { root, saveScenarioDefinition } = await renderEditor(
      fixture({ evSettings: { targetSoc: 90 } }),
    );
    unmount = () => act(() => root.unmount());

    await clickButton("Scenario EV Settings");
    expect(control<HTMLInputElement>("Target SoC (%)").value).toBe("90");

    await type(control<HTMLInputElement>("Battery (kWh)"), "60");
    await clickButton("Save");

    expect(lastSaved(saveScenarioDefinition)?.evSettings).toEqual({
      targetSoc: 90,
      batteryCapacityKwh: 60,
    });
  });

  it("saves no EV settings once every field is cleared", async () => {
    const { root, saveScenarioDefinition } = await renderEditor(
      fixture({ evSettings: { targetSoc: 90 } }),
    );
    unmount = () => act(() => root.unmount());

    await clickButton("Scenario EV Settings");
    await type(control<HTMLInputElement>("Target SoC (%)"), "");
    await clickButton("Save");

    expect(lastSaved(saveScenarioDefinition)).toBeDefined();
    expect(lastSaved(saveScenarioDefinition)?.evSettings).toBeUndefined();
  });
});
