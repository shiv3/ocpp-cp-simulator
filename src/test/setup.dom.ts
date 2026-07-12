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

// Node >=25 ships a native global `localStorage`/`sessionStorage` that is
// present but throws on every call unless the process is started with
// `--localstorage-file=<path>`. That native object shadows jsdom's own
// (working) storage implementation, which breaks any code that reads
// storage at module-evaluation or mount time (e.g. jotai's
// `atomWithStorage`, `DarkModeContext`'s theme lookup). Swap in a plain
// in-memory Storage polyfill whenever the platform one isn't usable.
function ensureWorkingStorage(name: "localStorage" | "sessionStorage") {
  const globalWithStorage = globalThis as Record<string, unknown>;
  const existing = globalWithStorage[name] as Storage | undefined;
  try {
    if (existing && typeof existing.getItem === "function") {
      existing.getItem("__storage_probe__");
      return;
    }
  } catch {
    // falls through to install the polyfill below
  }

  const store = new Map<string, string>();
  const polyfill: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) =>
      store.has(key) ? (store.get(key) as string) : null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, name, {
    value: polyfill,
    configurable: true,
    writable: true,
  });
}

// jsdom doesn't implement matchMedia. `DarkModeContext`'s "system" theme
// option reads it on every mount, so without a stub any component tree
// that includes `DarkModeProvider` throws as soon as it mounts.
function ensureMatchMedia() {
  if (typeof window.matchMedia === "function") return;
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
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
  ensureWorkingStorage("localStorage");
  ensureWorkingStorage("sessionStorage");
  ensureMatchMedia();
  mockReactFlow();
}
