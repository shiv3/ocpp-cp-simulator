/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface HookHarness {
  readonly state: any[];
  readonly effects: Array<() => void | (() => void)>;
  beginRender(): void;
}

function createHookHarness(): HookHarness {
  const state: any[] = [];
  const effects: Array<() => void | (() => void)> = [];
  let cursor = 0;

  const react = {
    createContext: vi.fn((value: unknown) => ({
      Provider: ({ children }: { children: unknown }) => children,
      value,
    })),
    useContext: vi.fn(() => null),
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (effect: () => void | (() => void)) => {
      effects.push(effect);
    },
    useState: (initial: any) => {
      const slot = cursor++;
      if (state.length <= slot) {
        state[slot] = typeof initial === "function" ? initial() : initial;
      }
      const setState = (next: any) => {
        state[slot] = typeof next === "function" ? next(state[slot]) : next;
      };
      return [state[slot], setState];
    },
  };

  vi.doMock("react", () => ({
    ...react,
    default: react,
  }));
  vi.doMock("jotai", () => ({
    Provider: ({ children }: { children: unknown }) => children,
  }));
  vi.doMock("jotai/vanilla", () => ({
    createStore: () => ({}),
  }));

  return {
    state,
    effects,
    beginRender() {
      cursor = 0;
      effects.splice(0);
    },
  };
}

function installWindow(origin: string): void {
  vi.stubGlobal("window", {
    location: { origin },
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  });
}

async function flush(): Promise<void> {
  // The detection effect chains fetch -> res.json() -> setState, several
  // microtask ticks deep; drain enough of them for the state to settle.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("DataProvider origin health detection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders remote mode when /v1/healthz returns 200 {ok:true}", async () => {
    installWindow("http://daemon.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true }),
      })),
    );
    const harness = createHookHarness();
    const { DataProvider } = await import("./DataProvider");

    harness.beginRender();
    DataProvider({ children: "child" });
    harness.effects[0]();
    await flush();

    expect(fetch).toHaveBeenCalledWith("http://daemon.test/v1/healthz", {
      method: "GET",
      cache: "no-store",
    });
    expect(harness.state[0]).toBe("remote");
    expect(harness.state[1]).toBe("http://daemon.test");
  });

  it("renders local mode when /v1/healthz is non-2xx", async () => {
    installWindow("http://static.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ ok: false }),
      })),
    );
    const harness = createHookHarness();
    const { DataProvider } = await import("./DataProvider");

    harness.beginRender();
    DataProvider({ children: "child" });
    harness.effects[0]();
    await flush();

    expect(fetch).toHaveBeenCalledWith("http://static.test/v1/healthz", {
      method: "GET",
      cache: "no-store",
    });
    expect(harness.state[0]).toBe("local");
  });
});
