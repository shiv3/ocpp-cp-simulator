// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import Combobox from "./Combobox";

const OPTIONS = [
  { value: "CP-ALPHA", hint: "1.6J", dot: "bg-emerald-500" },
  { value: "CP-BETA", hint: "2.0.1", dot: "bg-blue-500" },
  { value: "Other", hint: "1.6J" },
];

describe("Combobox", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  let changes: string[];

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

  /** A controlled harness, as the dashboard's URL state is. */
  async function mount(initial = "") {
    changes = [];
    function Harness() {
      const [value, setValue] = useState(initial);
      return (
        <Combobox
          id="cp-filter"
          aria-label="Charge point"
          placeholder="Charge point"
          value={value}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          options={OPTIONS}
        />
      );
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Harness />);
    });
  }

  const input = () =>
    container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const options = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
  const labels = () => options().map((o) => o.textContent);
  /** The options that are values, not the Clear row. */
  const picks = () => options().filter((o) => o.textContent !== "Clear");

  async function type(text: string) {
    await act(async () => {
      input().focus();
    });
    await act(async () => {
      // React tracks the value through the native setter.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function key(k: string) {
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  it("is a labelled combobox that opens its list on focus", async () => {
    await mount();
    expect(input().getAttribute("aria-label")).toBe("Charge point");
    expect(input().getAttribute("placeholder")).toBe("Charge point");
    expect(input().getAttribute("autocomplete")).toBe("off");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      input().focus();
    });

    expect(input().getAttribute("aria-expanded")).toBe("true");
    const list = container.querySelector('[role="listbox"]')!;
    expect(list.id).toBeTruthy();
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    // Every option, each with its hint.
    expect(labels()).toEqual(["CP-ALPHA1.6J", "CP-BETA2.0.1", "Other1.6J"]);
  });

  it("typing filters the options (case-insensitive) and reports the text", async () => {
    await mount();
    await type("be");
    expect(changes).toEqual(["be"]);
    expect(labels()[0]).toBe("Clear");
    expect(picks().map((o) => o.textContent)).toEqual(["CP-BETA2.0.1"]);
  });

  it("shows a No match row when nothing contains the text", async () => {
    await mount();
    await type("zzz");
    expect(container.textContent).toContain("No match");
    expect(picks()).toHaveLength(0);
  });

  it("Enter picks the first visible option and closes", async () => {
    await mount();
    await type("cp-");
    await key("Enter");
    expect(changes.at(-1)).toBe("CP-ALPHA");
    expect(input().value).toBe("CP-ALPHA");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("the chevron lists every option even when the input holds a partial text", async () => {
    await mount("CP-BE");
    const chevron = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show options"]',
    )!;
    expect(chevron.tabIndex).toBe(-1);
    await act(async () => {
      chevron.click();
    });
    expect(picks()).toHaveLength(3);
  });

  it("lists every option when the input equals one exactly", async () => {
    await mount("CP-BETA");
    await act(async () => {
      input().focus();
    });
    expect(picks()).toHaveLength(3);
  });

  it("picking an option sets the value and closes", async () => {
    await mount();
    await act(async () => {
      input().focus();
    });
    await act(async () => {
      options()[1].click();
    });
    expect(changes).toEqual(["CP-BETA"]);
    expect(input().value).toBe("CP-BETA");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("Clear is offered first when there is a value and empties it", async () => {
    await mount("CP-ALPHA");
    await act(async () => {
      input().focus();
    });
    expect(options()[0].textContent).toBe("Clear");

    await act(async () => {
      options()[0].click();
    });

    expect(changes).toEqual([""]);
    expect(input().value).toBe("");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("has no Clear option while the input is empty", async () => {
    await mount();
    await act(async () => {
      input().focus();
    });
    expect(labels()).not.toContain("Clear");
  });

  it("Escape closes the list and stops the event so a panel's Esc does not fire", async () => {
    await mount();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      await act(async () => {
        input().focus();
      });
      expect(container.querySelector('[role="listbox"]')).toBeTruthy();

      await key("Escape");

      expect(container.querySelector('[role="listbox"]')).toBeNull();
      expect(outer).not.toHaveBeenCalled();

      // Closed: Escape is no longer ours, it reaches the document.
      await key("Escape");
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("a pointerdown outside closes the list; inside it does not", async () => {
    await mount();
    await act(async () => {
      input().focus();
    });
    await act(async () => {
      container
        .querySelector('[role="listbox"]')!
        .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();

    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
