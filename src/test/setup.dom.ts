import type {} from "@testing-library/jest-dom/vitest";

class MockResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    setTimeout(() => {
      this.callback(
        [{ target } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }, 0);
  }

  unobserve() {}

  disconnect() {}
}

class MockDOMMatrixReadOnly {
  m22: number;

  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

let reactFlowMockInitialized = false;

export const mockReactFlow = () => {
  if (
    reactFlowMockInitialized ||
    typeof window === "undefined" ||
    typeof HTMLElement === "undefined" ||
    typeof SVGElement === "undefined"
  ) {
    return;
  }

  reactFlowMockInitialized = true;

  globalThis.ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly =
    MockDOMMatrixReadOnly as unknown as typeof DOMMatrixReadOnly;

  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      get() {
        return parseFloat(this.style.height) || 1;
      },
    },
    offsetWidth: {
      get() {
        return parseFloat(this.style.width) || 1;
      },
    },
  });

  Object.defineProperty(SVGElement.prototype, "getBBox", {
    value: () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    }),
  });
};

if (typeof window !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  mockReactFlow();
}
