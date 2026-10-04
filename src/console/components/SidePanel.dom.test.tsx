// @vitest-environment jsdom
import { act } from "react";
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

import SidePanel from "./SidePanel";

const STORAGE_KEY = "ocpp-cp.console.panel-width";

describe("SidePanel", () => {
  let root: Root | null = null;
  let container: HTMLElement;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.localStorage.clear();
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

  async function render(open: boolean, onClose: () => void = () => {}) {
    root ??= createRoot(container);
    await act(async () => {
      root!.render(
        <SidePanel open={open} onClose={onClose} label="Details">
          <p>body</p>
        </SidePanel>,
      );
    });
  }

  const handle = () =>
    container.querySelector<HTMLElement>('[role="separator"]')!;
  const press = async (key: string) => {
    await act(async () => {
      handle().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  };
  const width = () => Number(handle().getAttribute("aria-valuenow"));

  it("renders nothing when closed and a labelled panel when open", async () => {
    await render(false);
    expect(container.querySelector("aside")).toBeNull();
    expect(document.documentElement.hasAttribute("data-side-panel")).toBe(
      false,
    );

    await render(true);
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("aria-label")).toBe("Details");
    expect(aside?.textContent).toContain("body");
    expect(document.documentElement.hasAttribute("data-side-panel")).toBe(true);

    await render(false);
    expect(document.documentElement.hasAttribute("data-side-panel")).toBe(
      false,
    );
  });

  it("exposes the resize handle as a vertical separator with a 360 px minimum", async () => {
    await render(true);
    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
    expect(handle().getAttribute("aria-label")).toBe("Resize side panel");
    expect(handle().getAttribute("aria-valuemin")).toBe("360");
    expect(handle().tabIndex).toBe(0);
  });

  it("ArrowLeft widens by 32 px and stores it, ArrowRight narrows, never under 360", async () => {
    window.localStorage.setItem(STORAGE_KEY, "400");
    await render(true);
    expect(width()).toBe(400);

    await press("ArrowLeft");
    expect(width()).toBe(432);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("432");
    expect(
      container
        .querySelector<HTMLElement>("aside")!
        .style.getPropertyValue("--console-panel-width"),
    ).toBe("432px");

    await press("ArrowRight");
    await press("ArrowRight");
    expect(width()).toBe(368);

    await press("ArrowRight");
    expect(width()).toBe(360);
    await press("ArrowRight");
    expect(width()).toBe(360);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("360");
  });

  it("calls onClose on Esc, but not when the keydown was already handled", async () => {
    const onClose = vi.fn();
    await render(true, onClose);

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // A Radix dialog handles Esc in the capture phase and prevents default.
    const claim = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", claim, true);
    try {
      await act(async () => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    } finally {
      document.removeEventListener("keydown", claim, true);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
