// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ScenarioFlowNodeType,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { setLocale, t } from "../../../../i18n";
import { STEP_CATEGORIES, STEP_HELP } from "../../../lib/scenarioSteps";
import AddStepPicker from "./AddStepPicker";

let root: Root | null = null;
let container: HTMLElement;
const onPick = vi.fn();
const onClose = vi.fn();

async function render(
  props: Partial<React.ComponentProps<typeof AddStepPicker>> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AddStepPicker onPick={onPick} onClose={onClose} {...props} />,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  onPick.mockReset();
  onClose.mockReset();
});

const option = (type: string) =>
  container.querySelector<HTMLButtonElement>(
    `button[data-step-type="${type}"]`,
  )!;
const help = () =>
  container.querySelector<HTMLElement>('[data-testid="step-picker-help"]')!;
const search = () =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Search step types"]',
  )!;

async function type(text: string) {
  const input = search();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}

describe("AddStepPicker", () => {
  beforeAll(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    await setLocale("en");
  });

  it("groups loops, branching and run state apart from Advanced types", async () => {
    await render();
    const headings = Array.from(
      container.querySelectorAll("div.uppercase"),
    ).map((e) => e.textContent);
    expect(headings).toEqual([
      "Status",
      "Transaction & reservation",
      "Meter & EV",
      "Wait & Trigger",
      "Flow control",
      "OCPP messages",
      "Station quirks & config",
    ]);
    expect(headings).not.toContain("Advanced");
    const flow = STEP_CATEGORIES.find((c) => c.label === "Flow control")!;
    expect(flow.types).toEqual([
      ScenarioNodeType.SWITCH,
      ScenarioNodeType.CHOICE,
      ScenarioNodeType.SET_STATE,
      ScenarioFlowNodeType.PARALLEL,
      ScenarioFlowNodeType.JOIN,
    ]);
  });

  it("shows a hint first, then the described type on hover", async () => {
    await render();
    expect(help().textContent).toContain(t("scenarios.addStep.helpHint"));
    await act(async () => {
      option("switch").dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true }),
      );
      option("switch").dispatchEvent(
        new MouseEvent("mouseenter", { bubbles: false }),
      );
    });
    // React's onMouseEnter listens to mouseover.
    expect(help().textContent).toContain(t(STEP_HELP[ScenarioNodeType.SWITCH]));
    expect(help().textContent).toContain("Switch");
    expect(option("switch").getAttribute("aria-describedby")).toBe(help().id);
    expect(option("choice").getAttribute("aria-describedby")).toBeNull();
  });

  it("lists parallel and join under Flow control and describes them", async () => {
    await render();
    for (const type of [
      ScenarioFlowNodeType.PARALLEL,
      ScenarioFlowNodeType.JOIN,
    ]) {
      await act(async () => {
        option(type).dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true }),
        );
      });
      expect(help().textContent).toContain(t(STEP_HELP[type]));
      expect(option(type).querySelector("svg")).not.toBeNull();
    }
  });

  it("describes the focused type and moves with ArrowDown / ArrowUp", async () => {
    await render();
    await key(search(), "ArrowDown");
    const first = container.querySelector<HTMLButtonElement>(
      "button[data-step-option]",
    )!;
    expect(document.activeElement).toBe(first);
    expect(help().textContent).toContain(
      t(STEP_HELP[first.dataset.stepType as keyof typeof STEP_HELP]),
    );
    await key(first, "ArrowDown");
    const second = document.activeElement as HTMLButtonElement;
    expect(second).not.toBe(first);
    expect(second.getAttribute("aria-describedby")).toBe(help().id);
    await key(second, "ArrowUp");
    expect(document.activeElement).toBe(first);
  });

  it("searches the description as well as the title", async () => {
    await render();
    await type("weight");
    expect(option("choice")).toBeTruthy();
    expect(option("delay")).toBeNull();
    await type("zzzz-nothing");
    expect(container.textContent).toContain("No matches");
  });

  it("gives every pickable type a description in every locale", async () => {
    for (const locale of ["en", "ja", "fr", "zh-CN"] as const) {
      await setLocale(locale);
      for (const category of STEP_CATEGORIES) {
        for (const type of category.types) {
          const text = t(STEP_HELP[type as keyof typeof STEP_HELP]);
          expect(text.length, `${locale} ${type}`).toBeGreaterThan(20);
          expect(text).not.toContain("scenarios.stepHelp");
        }
      }
    }
    await setLocale("en");
  });

  it("hides the Repeat entry unless a structure handler is wired", async () => {
    await render();
    expect(container.querySelector("[data-step-structure]")).toBeNull();
    expect(container.textContent).not.toContain("Repeat");
  });

  it("lists Repeat under Flow control and describes / picks it when wired", async () => {
    const onPickStructure = vi.fn();
    await render({ onPickStructure });
    const repeat = container.querySelector<HTMLButtonElement>(
      'button[data-step-structure="loop"]',
    )!;
    expect(repeat.closest("div")!.parentElement!.textContent).toContain(
      "Flow control",
    );
    await act(async () => repeat.focus());
    expect(help().textContent).toContain("Repeats the steps inside it");
    expect(repeat.getAttribute("aria-describedby")).toBe(help().id);
    await type("repeat");
    expect(container.querySelector("[data-step-structure]")).toBeTruthy();
    await act(async () => repeat.click());
    expect(onPickStructure).toHaveBeenCalledWith("loop");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("a refused entry stays focusable; hover or focus shows why in the help pane, and picking it does nothing", async () => {
    const onPickStructure = vi.fn();
    await render({
      onPickStructure,
      structureRefusals: { loop: "No step before this slot." },
      typeRefusals: { [ScenarioNodeType.DELAY]: "Not a delay here." },
    });
    const repeat = container.querySelector<HTMLButtonElement>(
      'button[data-step-structure="loop"]',
    )!;
    expect(repeat.disabled).toBe(false);
    expect(repeat.getAttribute("aria-disabled")).toBe("true");
    expect(repeat.title).toBe("No step before this slot.");
    await act(async () => {
      repeat.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(help().textContent).toContain("Repeats the steps inside it");
    expect(
      container.querySelector('[data-testid="step-picker-refusal"]')
        ?.textContent,
    ).toBe("No step before this slot.");
    await act(async () => repeat.click());
    expect(onPickStructure).not.toHaveBeenCalled();

    // A refused step type, reached with the keyboard.
    await act(async () => option(ScenarioNodeType.DELAY).focus());
    expect(
      container.querySelector('[data-testid="step-picker-refusal"]')
        ?.textContent,
    ).toBe("Not a delay here.");
    await act(async () => option(ScenarioNodeType.DELAY).click());
    expect(onPick).not.toHaveBeenCalled();

    // An entry that is not refused shows no reason.
    await act(async () => option(ScenarioNodeType.NOTIFICATION).focus());
    expect(
      container.querySelector('[data-testid="step-picker-refusal"]'),
    ).toBeNull();
  });

  it("still picks a type and closes on Escape", async () => {
    await render();
    await act(async () => option("delay").click());
    expect(onPick).toHaveBeenCalledWith(ScenarioNodeType.DELAY);
    await key(search(), "Escape");
    expect(onClose).toHaveBeenCalled();
  });
});
