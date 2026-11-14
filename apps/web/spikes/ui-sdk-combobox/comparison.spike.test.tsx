import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import ProductionCombobox from "../../src/console/components/Combobox";
import { UiSdkCombobox } from "./UiSdkCombobox";

/**
 * One behavior suite run against both implementations of the same props.
 * `gap: true` marks a behavior the implementation does not have today: the
 * test then asserts it FAILS, so the comparison table in
 * docs/analyses/ui-sdk-evaluation.md is executable and a change on either side
 * shows up here.
 */
const OPTIONS = [
  { value: "CP-ALPHA", hint: "1.6J", dot: "bg-emerald-500" },
  { value: "CP-BETA", hint: "2.0.1", dot: "bg-blue-500" },
  { value: "Other", hint: "1.6J" },
];

type Impl = {
  name: string;
  Component: React.ComponentType<{
    id: string;
    value: string;
    onChange: (v: string) => void;
    options: typeof OPTIONS;
    placeholder: string;
    "aria-label": string;
  }>;
  /** Behaviors the implementation lacks, by test name. */
  gaps: string[];
};

const IMPLS: Impl[] = [
  {
    name: "production (hand-rolled)",
    Component: ProductionCombobox,
    gaps: [
      "ArrowDown moves a highlight through the options (aria-activedescendant)",
      "Enter chooses the highlighted option, not the first",
    ],
  },
  { name: "@ui-sdk/react Autocomplete", Component: UiSdkCombobox, gaps: [] },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe.each(IMPLS)("$name", ({ Component, gaps }) => {
  let root: Root | null = null;
  let container: HTMLElement;
  let changes: string[];

  afterEach(async () => {
    if (root) {
      const r = root;
      await act(async () => r.unmount());
      root = null;
    }
    document.body.innerHTML = "";
  });

  async function mount(initial = "") {
    changes = [];
    function Harness() {
      const [value, setValue] = useState(initial);
      return (
        <Component
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
    container.ownerDocument.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
  const options = () =>
    Array.from(
      container.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]'),
    );
  // The SDK keeps filtered-out options in the DOM with `hidden`; the user sees
  // (and a screen reader reads) only the others.
  const picks = () =>
    options().filter((o) => o.textContent !== "Clear" && !o.hidden);

  async function focus() {
    await act(async () => {
      input().focus();
    });
  }
  async function type(text: string) {
    await focus();
    await act(async () => {
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

  /** A gap test is expected to fail; everything else must pass. */
  function check(name: string, body: () => Promise<void>) {
    if (gaps.includes(name)) it.fails(`GAP: ${name}`, body);
    else it(name, body);
  }

  check("is a combobox named by its label and opens on focus", async () => {
    await mount();
    expect(input().getAttribute("aria-label")).toBe("Charge point");
    await focus();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(picks().length).toBe(3);
  });

  check("typing narrows the options and reports the text", async () => {
    await mount();
    await type("beta");
    expect(changes).toEqual(["beta"]);
    expect(picks().map((o) => o.textContent)).toEqual(["CP-BETA2.0.1"]);
  });

  check("free text that matches nothing stays as typed", async () => {
    await mount();
    await type("zzz");
    expect(input().value).toBe("zzz");
    expect(picks().length).toBe(0);
  });

  check(
    "clicking an option sets the text and keeps focus in the input",
    async () => {
      await mount();
      await focus();
      await act(async () => {
        picks()[1].click();
      });
      expect(changes.at(-1)).toBe("CP-BETA");
      expect(document.activeElement).toBe(input());
    },
  );

  check(
    "ArrowDown moves a highlight through the options (aria-activedescendant)",
    async () => {
      await mount();
      await focus();
      await key("ArrowDown");
      await key("ArrowDown");
      const active = input().getAttribute("aria-activedescendant");
      expect(active).toBeTruthy();
      expect(document.getElementById(active!)?.textContent).toContain(
        "CP-BETA",
      );
    },
  );

  check("Enter chooses the highlighted option, not the first", async () => {
    await mount();
    await focus();
    await key("ArrowDown");
    await key("ArrowDown");
    await key("Enter");
    expect(changes.at(-1)).toBe("CP-BETA");
  });

  check("Escape keeps the typed text", async () => {
    await mount();
    await type("CP-B");
    await key("Escape");
    expect(input().value).toBe("CP-B");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });
});
