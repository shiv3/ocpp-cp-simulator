// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import CollapsibleSide from "./CollapsibleSide";
import { useCollapsedPanel } from "../lib/collapsedPanel";

let root: Root | null = null;
const KEY = "test.panel.collapsed";

const Host = () => {
  const panel = useCollapsedPanel(KEY);
  return (
    <>
      <button type="button" data-pick onClick={() => panel.setCollapsed(false)}>
        pick
      </button>
      <CollapsibleSide
        testId="side"
        collapsed={panel.collapsed}
        onCollapsedChange={panel.setCollapsed}
        label="Step settings"
      >
        <input data-field />
      </CollapsibleSide>
    </>
  );
};

describe("CollapsibleSide", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    window.localStorage.clear();
  });
  const mount = async () => {
    const c = document.createElement("div");
    document.body.appendChild(c);
    root = createRoot(c);
    await act(async () => root!.render(<Host />));
    return c;
  };
  const click = async (el: Element | null) =>
    act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

  it("folds to a rail, keeps its content mounted, remembers and expands", async () => {
    const c = await mount();
    const side = () => c.querySelector("[data-testid=side]")!;
    expect(side().hasAttribute("data-collapsed")).toBe(false);
    await click(
      c.querySelector("button[aria-label='Collapse the step panel']"),
    );
    expect(side().hasAttribute("data-collapsed")).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("1");
    expect(c.querySelector("[data-field]")).not.toBeNull();
    const expand = c.querySelector(
      "button[aria-label='Expand the step panel']",
    )!;
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await click(expand);
    expect(side().hasAttribute("data-collapsed")).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("starts collapsed when remembered, and opens when asked to", async () => {
    window.localStorage.setItem(KEY, "1");
    const c = await mount();
    expect(
      c.querySelector("[data-testid=side]")!.hasAttribute("data-collapsed"),
    ).toBe(true);
    await click(c.querySelector("[data-pick]"));
    expect(
      c.querySelector("[data-testid=side]")!.hasAttribute("data-collapsed"),
    ).toBe(false);
  });
});
