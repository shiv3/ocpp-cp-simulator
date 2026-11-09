// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ScenarioValueField,
  type ScenarioValueFieldProps,
} from "../ScenarioValueField";

let root: Root | null = null;
let values: unknown[] = [];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const current = root;
  if (current) await act(async () => current.unmount());
  root = null;
  values = [];
  document.body.replaceChildren();
});

function Harness(
  props: Omit<ScenarioValueFieldProps, "value" | "onChange"> & {
    initial: unknown;
  },
) {
  const { initial, ...rest } = props;
  const [value, setValue] = useState<unknown>(initial);
  return (
    <ScenarioValueField
      {...rest}
      value={value}
      onChange={(next) => {
        values.push(next);
        setValue(next);
      }}
    />
  );
}

async function render(
  initial: unknown,
  props: Partial<ScenarioValueFieldProps> = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<Harness label="Value" initial={initial} {...props} />),
  );
  return container;
}

function byLabel<T extends HTMLElement>(label: string): T {
  const el = document.body.querySelector<T>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no control labelled ${label}`);
  return el;
}

async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): Promise<void> {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function select(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(text: string): Promise<void> {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`no button ${text}`);
  await act(async () => button.click());
}

const typeSelect = () => byLabel<HTMLSelectElement>("Type of Value");

describe("ScenarioValueField", () => {
  it.each([
    ["text", "Charging"],
    ["number", 7],
    ["boolean", false],
    ["null", null],
    ["json", { a: [1, 2] }],
  ] as const)(
    "shows a %s constant as that type, unchanged",
    async (type, v) => {
      await render(v);
      expect(typeSelect().value).toBe(type);
      expect(values).toEqual([]);
    },
  );

  it("edits a text, a number and a boolean", async () => {
    await render("a");
    await type(byLabel<HTMLInputElement>("Value"), "Faulted");
    expect(values.at(-1)).toBe("Faulted");

    await select(typeSelect(), "number");
    expect(values.at(-1)).toBe(0);
    await type(byLabel<HTMLInputElement>("Value"), "12.5");
    expect(values.at(-1)).toBe(12.5);
    await type(byLabel<HTMLInputElement>("Value"), "12x");
    expect(values.at(-1)).toBe(12.5);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(
      /not a number/i,
    );

    await select(typeSelect(), "boolean");
    expect(values.at(-1)).toBe(true);
    await select(byLabel<HTMLSelectElement>("Value"), "false");
    expect(values.at(-1)).toBe(false);
  });

  it("keeps the last valid JSON while the text does not parse", async () => {
    await render([1]);
    const area = byLabel<HTMLTextAreaElement>("Value");
    await type(area, '{"a": ');
    expect(values).toEqual([]);
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    await type(area, '"plain"');
    expect(values.at(-1)).toBe("plain");
    // JSON stays chosen though the value now reads as text.
    expect(typeSelect().value).toBe("json");
  });

  it("shows an unknown shape as JSON without changing it", async () => {
    const odd = { $from: "station.id", extra: true };
    await render(odd);
    expect(typeSelect().value).toBe("json");
    expect(JSON.parse(byLabel<HTMLTextAreaElement>("Value").value)).toEqual(
      odd,
    );
    expect(values).toEqual([]);
  });

  it.each([
    ["call", "payload.requestId"],
    ["charger", "status"],
    ["connector", "power.offeredW"],
    ["state", "mode"],
  ])("round-trips a $from on %s", async (rootName, path) => {
    const value = { $from: `${rootName}.${path}` };
    await render(value, { stateKeys: ["mode"] });
    expect(byLabel<HTMLSelectElement>("Root of Value").value).toBe(rootName);
    expect(byLabel<HTMLInputElement>("Path of Value").value).toBe(path);
    expect(values).toEqual([]);
  });

  it("switches to Read from… and back, building the $from", async () => {
    await render(3, { stateKeys: ["attempts"] });
    await click("Read from…");
    expect(values.at(-1)).toEqual({ $from: "connector.status" });
    await select(byLabel<HTMLSelectElement>("Root of Value"), "state");
    expect(values.at(-1)).toEqual({ $from: "state.attempts" });
    await type(byLabel<HTMLInputElement>("Path of Value"), "other");
    expect(values.at(-1)).toEqual({ $from: "state.other" });
    expect(document.body.textContent).toMatch(/No setState step/);
    await click("Constant");
    expect(values.at(-1)).toBe(3);
  });

  it("offers Not set when optional, and only whole numbers when integer", async () => {
    await render(undefined, {
      optional: true,
      types: ["number"],
      integer: true,
    });
    expect(typeSelect().value).toBe("unset");
    await select(typeSelect(), "number");
    expect(values.at(-1)).toBe(0);
    await type(byLabel<HTMLInputElement>("Value"), "1.5");
    expect(values.at(-1)).toBe(0);
    await type(byLabel<HTMLInputElement>("Value"), "42");
    expect(values.at(-1)).toBe(42);
    await select(typeSelect(), "unset");
    expect(values.at(-1)).toBeUndefined();
  });

  it("has no Read from… for constants only", async () => {
    await render({ $from: "state.x" }, { allowFrom: false });
    expect(
      Array.from(document.body.querySelectorAll("button")).map(
        (b) => b.textContent,
      ),
    ).not.toContain("Read from…");
    expect(typeSelect().value).toBe("json");
  });

  it("with min 0, rejects a negative number but keeps $from (L3)", async () => {
    await render(5, {
      optional: true,
      types: ["number"],
      integer: true,
      min: 0,
    });
    await type(byLabel<HTMLInputElement>("Value"), "-1");
    expect(values).toEqual([]);
    expect(document.body.textContent).toMatch(/Must be at least 0/);
    await type(byLabel<HTMLInputElement>("Value"), "0");
    expect(values.at(-1)).toBe(0);
    await click("Read from…");
    expect(values.at(-1)).toEqual({ $from: "connector.status" });
  });

  it("shows a stored negative as it is, with the notice (L3)", async () => {
    await render(-3, { types: ["number"], integer: true, min: 0 });
    expect(byLabel<HTMLInputElement>("Value").value).toBe("-3");
    expect(document.body.textContent).toMatch(/Must be at least 0/);
    expect(values).toEqual([]);
  });

  it("is quiet on a deep known path, notes an unknown one softly (L4)", async () => {
    await render({ $from: "charger.connectorIds.0" });
    expect(document.body.textContent).not.toMatch(/known/);
    await type(byLabel<HTMLInputElement>("Path of Value"), "power");
    expect(document.body.textContent).toMatch(/it may still resolve/);
    await select(byLabel<HTMLSelectElement>("Root of Value"), "connector");
    await type(byLabel<HTMLInputElement>("Path of Value"), "power");
    expect(document.body.textContent).not.toMatch(/it may still resolve/);
  });
});
