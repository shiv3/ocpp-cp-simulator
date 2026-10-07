// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import RunStatePill from "./RunStatePill";

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let mounted: Root | null = null;

afterEach(() => {
  if (mounted) {
    const root = mounted;
    act(() => {
      root.unmount();
    });
    mounted = null;
  }
  document.body.innerHTML = "";
});

describe("RunStatePill", () => {
  it("renders a state-colored dot and the lowercase state text", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = root;
    act(() => {
      root.render(<RunStatePill state="stepping" />);
    });
    const pill = container.firstElementChild as HTMLElement;
    expect(pill.textContent).toBe("stepping");
    expect((pill.firstElementChild as HTMLElement).className).toContain(
      "bg-cx-purple",
    );
    expect(pill.className).not.toMatch(/\bbg-|rounded-full/);
  });
});
