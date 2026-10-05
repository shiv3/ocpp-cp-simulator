// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import BottomPanel from "./BottomPanel";

const KEY = "test.panel";
const TABS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

describe("BottomPanel", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  const onSelect = vi.fn();

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.localStorage.clear();
    onSelect.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    document.body.innerHTML = "";
  });

  function Harness() {
    const [active, setActive] = useState<"a" | "b" | "c">("a");
    return (
      <BottomPanel
        label="Test panel"
        tabs={TABS}
        active={active}
        onSelect={(value) => {
          onSelect(value);
          setActive(value);
        }}
        storageKey={KEY}
        tabsLabel="Test sections"
        toolbar={<a href="/x">Tool link</a>}
      >
        <p>content of {active}</p>
      </BottomPanel>
    );
  }

  async function render() {
    root ??= createRoot(container);
    await act(async () => {
      root!.render(<Harness />);
    });
  }

  const section = () =>
    container.querySelector<HTMLElement>('[data-testid="bottom-panel"]')!;
  const chevron = () =>
    container.querySelector<HTMLElement>(
      'button[aria-label="Collapse panel"], button[aria-label="Expand panel"]',
    )!;
  const body = () => container.querySelector<HTMLElement>('[role="tabpanel"]')!;
  const tab = (label: string) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (t) => t.textContent === label,
    )!;
  const handle = () =>
    container.querySelector<HTMLElement>('[role="separator"]')!;
  const height = () => Number(handle().getAttribute("aria-valuenow"));
  const click = async (el: Element) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const key = async (el: Element, k: string) => {
    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  };

  it("renders a labelled section with a tablist of the tabs, the active content and the toolbar", async () => {
    await render();
    expect(section().getAttribute("aria-label")).toBe("Test panel");
    expect(section().dataset.collapsed).toBe("false");
    const list = container.querySelector('[role="tablist"]')!;
    expect(list.getAttribute("aria-label")).toBe("Test sections");
    expect(
      Array.from(list.querySelectorAll('[role="tab"]')).map(
        (t) => t.textContent,
      ),
    ).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(tab("Alpha").getAttribute("aria-selected")).toBe("true");
    expect(tab("Alpha").getAttribute("aria-controls")).toBe(body().id);
    expect(body().getAttribute("aria-labelledby")).toBe(tab("Alpha").id);
    expect(body().textContent).toBe("content of a");
    expect(container.textContent).toContain("Tool link");
  });

  it("the chevron collapses to the tab strip and expands again; data-collapsed and body hidden follow", async () => {
    await render();
    expect(chevron().getAttribute("aria-label")).toBe("Collapse panel");
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(chevron().getAttribute("aria-controls")).toBe(body().id);
    expect(body().hidden).toBe(false);

    await click(chevron());

    expect(chevron().getAttribute("aria-label")).toBe("Expand panel");
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(section().dataset.collapsed).toBe("true");
    expect(body().hidden).toBe(true);
    // Still mounted: a log viewer keeps its state.
    expect(body().textContent).toBe("content of a");
    expect(section().style.height).toBe("");
    expect(container.querySelector('[role="separator"]')).toBeNull();

    await click(chevron());
    expect(section().dataset.collapsed).toBe("false");
    expect(body().hidden).toBe(false);
    expect(section().style.height).toBe("320px");
  });

  it("a tab click while collapsed selects it and expands; the active tab does nothing", async () => {
    await render();
    await click(chevron());

    await click(tab("Beta"));

    expect(onSelect).toHaveBeenCalledWith("b");
    expect(section().dataset.collapsed).toBe("false");
    expect(body().textContent).toBe("content of b");

    // Clicking the active tab while expanded leaves the panel open.
    await click(tab("Beta"));
    expect(section().dataset.collapsed).toBe("false");
  });

  it("double-clicking the bar's empty area toggles; a button ignores it", async () => {
    await render();
    const bar =
      tab("Alpha").closest<HTMLElement>('[role="tablist"]')!.parentElement!;
    await act(async () => {
      bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(section().dataset.collapsed).toBe("true");
    await act(async () => {
      tab("Beta").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(section().dataset.collapsed).toBe("true");
  });

  it("exposes a horizontal separator; ArrowDown shrinks by 32 px, ArrowUp grows, never under 120", async () => {
    await render();
    expect(handle().getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle().getAttribute("aria-label")).toBe("Resize panel");
    expect(handle().getAttribute("aria-valuemin")).toBe("120");
    expect(handle().tabIndex).toBe(0);
    expect(height()).toBe(320);

    await key(handle(), "ArrowUp");
    expect(height()).toBe(352);
    expect(section().style.height).toBe("352px");
    await key(handle(), "ArrowDown");
    expect(height()).toBe(320);

    for (let i = 0; i < 8; i++) await key(handle(), "ArrowDown");
    expect(height()).toBe(120);
    await key(handle(), "ArrowDown");
    expect(height()).toBe(120);
  });

  it("keeps the height and the collapsed flag in localStorage and reads them back", async () => {
    await render();
    await key(handle(), "ArrowUp");
    expect(window.localStorage.getItem(`${KEY}.height`)).toBe("352");
    expect(window.localStorage.getItem(`${KEY}.collapsed`)).toBeNull();

    await click(chevron());
    expect(window.localStorage.getItem(`${KEY}.collapsed`)).toBe("1");
    await click(chevron());
    expect(window.localStorage.getItem(`${KEY}.collapsed`)).toBeNull();
    await click(chevron());

    await act(async () => root!.unmount());
    root = null;
    document.body.removeChild(container);
    container = document.createElement("div");
    document.body.appendChild(container);
    await render();

    expect(section().dataset.collapsed).toBe("true");
    await click(chevron());
    expect(height()).toBe(352);
  });

  it("arrow keys, Home and End move between the tabs", async () => {
    await render();
    const list = container.querySelector('[role="tablist"]')!;
    await key(list, "ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("b");
    expect(tab("Beta").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Beta"));
    await key(list, "End");
    expect(onSelect).toHaveBeenLastCalledWith("c");
    await key(list, "ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("a");
    await key(list, "ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("c");
    await key(list, "Home");
    expect(onSelect).toHaveBeenLastCalledWith("a");
  });

  it("Esc does not collapse it", async () => {
    await render();
    await key(document.body, "Escape");
    await key(tab("Alpha"), "Escape");
    expect(section().dataset.collapsed).toBe("false");
  });
});
