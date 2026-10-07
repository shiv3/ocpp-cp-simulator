import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { ConsoleRoutes } from "../ConsoleApp";
import { DarkModeProvider } from "../../contexts/DarkModeContext";
import LocationReporter, { type ReportedLocation } from "./LocationReporter";
import { DataContext } from "../../data/providers/DataProvider";
import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
} from "../../data/interfaces/ChargePointService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;

export interface FakeChargePointServiceHandlers {
  /** Handlers registered via `subscribe(cpId, handler)`, keyed by cpId. */
  subscribe: Map<string, Set<Handler>>;
  /** Handlers registered via `subscribeConfig(handler)` (no key — global). */
  subscribeConfig: Set<Handler>;
  /** Handlers registered via `subscribeRegistry(handler)` (no key — global). */
  subscribeRegistry: Set<Handler>;
  /** Handlers registered via `subscribeScenarioDefinitions(cpId, connectorId, handler)`,
   *  keyed by `scenarioDefinitionsKey(cpId, connectorId)`. */
  subscribeScenarioDefinitions: Map<string, Set<Handler>>;
}

export type FakeChargePointService = ChargePointService & {
  __handlers: FakeChargePointServiceHandlers;
};

/** Composite key used by `__handlers.subscribeScenarioDefinitions` — use this
 *  instead of hand-building the string so the format stays private. */
export function scenarioDefinitionsKey(
  cpId: string,
  connectorId: number | null,
): string {
  return `${cpId}:${connectorId ?? "cp"}`;
}

function registerHandler<K>(
  map: Map<K, Set<Handler>>,
  key: K,
  handler: Handler,
): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

/**
 * Builds a fully-stubbed `ChargePointService` for dom tests.
 *
 * - `listChargePoints` resolves `overrides.snapshots ?? []`.
 * - `getChargePoint(id)` finds the matching snapshot (or null).
 * - `subscribe` / `subscribeConfig` / `subscribeRegistry` /
 *   `subscribeScenarioDefinitions` return no-op unsubscribers and record
 *   every handler on `__handlers` so tests can push synthetic events
 *   straight into whatever the component under test subscribed with.
 * - Any other method is lazily backed by `vi.fn(async () => undefined)` on
 *   first access, so a test only has to describe the calls it cares about.
 */
export function createFakeChargePointService(
  overrides?: Partial<ChargePointService> & {
    snapshots?: ChargePointSnapshot[];
  },
): FakeChargePointService {
  const { snapshots, ...rest } = overrides ?? {};
  const handlers: FakeChargePointServiceHandlers = {
    subscribe: new Map(),
    subscribeConfig: new Set(),
    subscribeRegistry: new Set(),
    subscribeScenarioDefinitions: new Map(),
  };

  const base: Record<string, unknown> = {
    listChargePoints: vi.fn(async () => snapshots ?? []),
    getChargePoint: vi.fn(
      async (id: string) => snapshots?.find((s) => s.id === id) ?? null,
    ),
    subscribe: vi.fn((id: string, handler: Handler) =>
      registerHandler(handlers.subscribe, id, handler),
    ),
    subscribeConfig: vi.fn((handler: Handler) => {
      handlers.subscribeConfig.add(handler);
      return () => handlers.subscribeConfig.delete(handler);
    }),
    subscribeRegistry: vi.fn((handler: Handler) => {
      handlers.subscribeRegistry.add(handler);
      return () => handlers.subscribeRegistry.delete(handler);
    }),
    subscribeScenarioDefinitions: vi.fn(
      (id: string, connectorId: number | null, handler: Handler) =>
        registerHandler(
          handlers.subscribeScenarioDefinitions,
          scenarioDefinitionsKey(id, connectorId),
          handler,
        ),
    ),
    ...rest,
  };

  const service = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "__handlers") return handlers;
      if (typeof prop === "symbol" || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      const stub = vi.fn(async () => undefined);
      target[prop] = stub;
      return stub;
    },
  });

  return service as unknown as FakeChargePointService;
}

export type { ReportedLocation };

export interface RenderConsoleResult<S extends ChargePointService> {
  container: HTMLElement;
  root: Root;
  service: S;
}

/**
 * Renders `<ConsoleRoutes/>` inside a `MemoryRouter` + a `DataContext`
 * wired to a fake (or caller-supplied) `ChargePointService`. Also wraps
 * with `DarkModeProvider` since `AppShell` (mounted on every route) renders
 * `ThemeToggle`, which needs it.
 *
 * The console is mounted at `/*`, as in `App.tsx`; `initialPath` is the
 * route to open (`/`, `/settings`, `/cp/:id`, …). `onLocationChange` (optional)
 * is called with the router's location after every navigation, so a test can
 * assert on the URL (`?cp=…`) without reading it from the DOM.
 */
export async function renderConsole<
  S extends ChargePointService = FakeChargePointService,
>(
  initialPath: string,
  opts?: {
    service?: S;
    mode?: "local" | "remote";
    onLocationChange?: (location: ReportedLocation) => void;
  },
): Promise<RenderConsoleResult<S>> {
  const service = (opts?.service ?? createFakeChargePointService()) as S;
  const mode = opts?.mode ?? "remote";

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        {opts?.onLocationChange && (
          <LocationReporter onChange={opts.onLocationChange} />
        )}
        <DarkModeProvider>
          <DataContext.Provider
            value={{
              mode,
              serverUrl: "http://test",
              defaultEvSettings: null,
              setDefaultEvSettings: () => {},
              chargePointService: service,
            }}
          >
            <Routes>
              <Route path="/*" element={<ConsoleRoutes />} />
            </Routes>
          </DataContext.Provider>
        </DarkModeProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });

  return { container, root, service };
}

/** Lets pending promise callbacks (a mount-time fetch, an RPC answer)
 *  settle inside `act`, so their state updates are flushed. */
export async function flush(hops = 5): Promise<void> {
  await act(async () => {
    for (let i = 0; i < hops; i += 1) await Promise.resolve();
  });
}

/** Opens a Radix `DropdownMenu`: its trigger opens on pointerdown (or
 *  Enter / Space / ArrowDown), not on `click`. The content renders in a
 *  portal, so query it from `document.body`. */
export async function openDropdownMenu(trigger: Element): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    await Promise.resolve();
  });
}

/** The open (portalled) menu item whose trimmed text is `label`. */
export function findMenuItem(label: string): HTMLElement | undefined {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((el) => el.textContent?.trim() === label);
}

/** Pushes a synthetic event through every handler the fake service recorded
 *  via `subscribe(cpId, handler)` — simulates CP / scenario progress without
 *  a real runtime. */
export async function pushEvent(
  service: FakeChargePointService,
  cpId: string,
  event: ChargePointEvent,
): Promise<void> {
  const handlers = service.__handlers.subscribe.get(cpId);
  if (!handlers || handlers.size === 0) {
    throw new Error(`no subscribe handler recorded for ${cpId}`);
  }
  await act(async () => {
    handlers.forEach((handler) => handler(event));
  });
}
