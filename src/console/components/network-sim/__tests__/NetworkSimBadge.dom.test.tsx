// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import NetworkSimBadge from "../NetworkSimBadge";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

describe("NetworkSimBadge", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("renders for enabled summary", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <NetworkSimBadge summary={{ enabled: true, manualRuleIds: [] }} />,
      );
    });

    expect(div.textContent).toContain("Net sim");
    expect(div.querySelector("[title]")?.getAttribute("title")).toBe(
      "Network simulation enabled",
    );
  });

  it("renders nothing for null summary", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(<NetworkSimBadge summary={null} />);
    });

    expect(div.innerHTML).toBe("");
  });

  it("renders nothing for undefined summary", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(<NetworkSimBadge summary={undefined} />);
    });

    expect(div.innerHTML).toBe("");
  });

  it("renders nothing when disabled", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    cleanup = () => unmount(root);

    act(() => {
      root.render(
        <NetworkSimBadge summary={{ enabled: false, manualRuleIds: [] }} />,
      );
    });

    expect(div.innerHTML).toBe("");
  });
});
