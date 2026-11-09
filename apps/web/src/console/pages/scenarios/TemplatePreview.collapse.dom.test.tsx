// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getTemplateById } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import TemplatePreview from "./TemplatePreview";

let root: Root | null = null;
const KEY = "ocpp-cp.console.template.inspector.collapsed";

describe("TemplatePreview: the step panel folds", () => {
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

  it("selecting a step while collapsed expands the panel", async () => {
    window.localStorage.setItem(KEY, "1");
    const c = document.createElement("div");
    document.body.appendChild(c);
    root = createRoot(c);
    await act(async () =>
      root!.render(
        <TemplatePreview
          template={getTemplateById("dataflow-authorize-branch-16")!}
          onUse={vi.fn()}
        />,
      ),
    );
    const panel = c.querySelector("[data-testid=template-step-detail]")!;
    expect(panel.hasAttribute("data-collapsed")).toBe(true);
    const card = c.querySelector(
      "[data-testid=graph-scroll] button[aria-pressed]",
    )!;
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(panel.hasAttribute("data-collapsed")).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
